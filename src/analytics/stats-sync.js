/**
 * stats-sync.js  (src/analytics/)
 *
 * Keeps the dashboard's numbers equal to LeetCode's real data, cheaply:
 *   - INCREMENTAL: walks the submission list newest-first and stops as soon
 *     as it reaches submissions it already has (usually 1 request).
 *   - FULL: only when there is no history yet (or when asked).
 *   - NEVER opens a new browser tab on its own (unless explicitly allowed):
 *     with no LeetCode tab open it just does nothing and the cached numbers
 *     are shown.
 * Solved-problem metadata (difficulty, topics) comes from LeetCode's own
 * solved list, refreshed at most every 12 hours or when a new solve appears.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const S = () => LGS.analytics.store;
  const bridgeCache = {};
  let running = false;

  function bridgeFor(allowOpen) {
    const k = allowOpen ? 'open' : 'closed';
    return bridgeCache[k] || (bridgeCache[k] = LGS.syncManager.createBridge(`stats-${k}`, { allowOpen }));
  }

  async function refresh({ force = false, allowOpen = false } = {}) {
    const meta = await S().getMeta();
    if (!force && meta.lastRefreshAt && Date.now() - meta.lastRefreshAt < LGS.CONST.STATS_STALE_MS) return { skipped: 'fresh' };
    if (running) return { skipped: 'running' };
    running = true;
    const bridge = bridgeFor(allowOpen);
    const retry = LGS.sync.retry.withRetry;
    try {
      let auth;
      try { auth = await retry(() => bridge.checkAuth()); }
      catch (err) {
        if (err.code === 'LEETCODE_NO_TAB' || err.code === 'LEETCODE_BRIDGE_ERROR') return { skipped: 'no-tab' };
        if (err.code === 'LEETCODE_NOT_AUTHENTICATED' || err.code === 'LEETCODE_BLOCKED') return { skipped: 'not-signed-in' };
        throw err;
      }
      if (auth && auth.isSignedIn === false) return { skipped: 'not-signed-in' };

      const known = new Set((await S().loadEvents()).map((e) => e.id));
      const full = force === 'full' || known.size === 0 || !meta.historyComplete;
      const maxPages = full ? 400 : 10;
      let offset = 0; let lastKey = null; let source = null; let pages = 0; let newEvents = 0; let newAccepted = 0; let complete = false; let lastSig = null;

      while (pages < maxPages) {
        let page;
        try { page = await retry(() => bridge.listPage({ offset, limit: 50, lastKey, source: source || 'auto' })); }
        catch (err) {
          if (pages === 0 && !['LEETCODE_NOT_AUTHENTICATED', 'LEETCODE_BLOCKED', 'LEETCODE_RATE_LIMITED'].includes(err.code)) {
            page = await retry(() => bridge.listPage({ offset, limit: 20, lastKey, source: source || 'auto' }));
          } else throw err;
        }
        source = page.source;
        const raw = page.rawCount != null ? page.rawCount : page.submissions.length;
        if (raw === 0) { complete = true; break; }
        const sig = page.submissions.slice(0, 3).map((s) => s.id).join(',') + '|' + raw;
        if (sig === lastSig) break; // pagination not advancing - stop quietly
        lastSig = sig;

        const unseen = page.submissions.filter((s) => s.id && !known.has(String(s.id))).length;
        const r = await S().addListItems(page.submissions);
        newEvents += r.added; newAccepted += r.newlyAccepted;
        pages++;
        if (!full && unseen === 0) break;
        offset += raw; lastKey = page.lastKey;
        if (!page.hasNext) { complete = true; break; }
        await LGS.formatter.sleep(200);
      }

      const patch = { lastRefreshAt: Date.now() };
      if (full && complete) patch.historyComplete = true;

      // Metadata (difficulty/topics) + LeetCode's own solved count.
      const needSolved = force || newAccepted > 0 || !meta.solvedAt || Date.now() - meta.solvedAt > 12 * 3600 * 1000;
      if (needSolved) {
        try {
          const solved = await retry(() => bridge.listSolved());
          await S().upsertProblems(solved.items.map((i) => ({ slug: i.slug, number: i.number, title: i.title, difficulty: LGS.formatter.normalizeDifficulty(i.difficulty), topics: i.topics, solved: true })));
          patch.solvedAt = Date.now();
        } catch (err) { LGS.logger.warn('Solved list unavailable for stats:', err.message); }
        try {
          const st = await bridge.getSolvedStats();
          if (st) await LGS.storage.setKey(LGS.CONST.STORAGE_KEYS.LEETCODE_STATS, Object.assign({}, st, { fetchedAt: LGS.formatter.nowIso() }));
        } catch (err) { /* optional */ }
      }

      // Accepted problems without metadata (not in the solved list yet): fill a few.
      const problems = await S().loadProblems();
      const events = await S().loadEvents();
      const missing = Array.from(new Set(events.filter((e) => e.ok === 1 && !(problems[e.slug] && problems[e.slug].difficulty)).map((e) => e.slug))).slice(0, 20);
      for (const slug of missing) {
        try {
          const q = await bridge.getQuestionMeta(slug);
          if (q) await S().upsertProblems([{ slug, number: q.number, title: q.title, difficulty: LGS.formatter.normalizeDifficulty(q.difficulty), topics: q.tags }]);
        } catch (err) { break; }
      }

      await S().setMeta(patch);
      return { ok: true, pages, newEvents, newAccepted, source, full };
    } finally {
      running = false;
    }
  }

  LGS.analytics = LGS.analytics || {};
  LGS.analytics.statsSync = { refresh, isRunning: () => running };
})(typeof self !== 'undefined' ? self : window);
