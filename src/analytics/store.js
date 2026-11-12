/**
 * store.js  (src/analytics/)
 *
 * Persistence for the progress dashboard. TWO independent stores:
 *   - events   : every submission we know about (accepted or not)
 *   - problems : the solved-problem map with metadata (difficulty, topics…)
 * Plus the live "current submission" status. Nothing here talks to GitHub:
 * LeetCode progress and GitHub saving are deliberately separate concepts.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const K = () => LGS.CONST.STORAGE_KEYS;
  const evLock = LGS.formatter.createMutex();
  const prLock = LGS.formatter.createMutex();
  const liveLock = LGS.formatter.createMutex();
  const A = LGS.CONST.ACCEPTED_STATUS;

  const loadEvents = () => LGS.storage.getKey(K().EVENTS, []);
  const loadProblems = () => LGS.storage.getKey(K().PROBLEMS, {});
  const getMeta = () => LGS.storage.getKey(K().STATS_META, {});
  const setMeta = (patch) => LGS.storage.getKey(K().STATS_META, {}).then((m) => LGS.storage.setKey(K().STATS_META, Object.assign(m, patch)));

  function langLabel(raw) { return LGS.languages.resolveLanguage(raw).label; }

  /** A submission-list item (REST/GraphQL, normalized) -> compact event, or null if unusable. */
  function eventFromListItem(sub) {
    if (!sub || !sub.id || !sub.titleSlug || sub.isPending || !sub.timestamp) return null;
    const ok = sub.statusHint ? (sub.statusHint === A ? 1 : 0) : null;
    const e = { id: String(sub.id), slug: sub.titleSlug, ts: sub.timestamp, ok, lang: langLabel(sub.lang || sub.langName), ti: sub.title || undefined };
    if (ok === 0) e.st = sub.statusHint;
    if (ok === 1) {
      if (sub.runtime && !/n\/a/i.test(sub.runtime)) e.rt = sub.runtime;
      if (sub.memory && !/n\/a/i.test(sub.memory)) e.mem = sub.memory;
    }
    return e;
  }

  /** Merge events by id. Returns { added, newlyAccepted }. */
  function addEvents(list) {
    return evLock(async () => {
      const events = await loadEvents();
      const byId = new Map(events.map((e) => [e.id, e]));
      let added = 0; let newlyAccepted = 0;
      for (const inc of list) {
        if (!inc) continue;
        const cur = byId.get(inc.id);
        if (!cur) { byId.set(inc.id, inc); added++; if (inc.ok === 1) newlyAccepted++; continue; }
        if (cur.ok == null && inc.ok != null) { cur.ok = inc.ok; if (inc.st) cur.st = inc.st; if (inc.ok === 1) newlyAccepted++; }
        ['rt', 'mem', 'ti', 'lang'].forEach((f) => { if (!cur[f] && inc[f]) cur[f] = inc[f]; });
      }
      let merged = Array.from(byId.values());
      if (merged.length > LGS.CONST.MAX_EVENTS) merged = merged.sort((a, b) => b.ts - a.ts).slice(0, LGS.CONST.MAX_EVENTS);
      if (added || newlyAccepted || merged.length !== events.length) await LGS.storage.setKey(K().EVENTS, merged);
      return { added, newlyAccepted };
    });
  }

  const addListItems = (subs) => addEvents((subs || []).map(eventFromListItem).filter(Boolean));

  function setEventGh(id, gh) {
    return evLock(async () => {
      const events = await loadEvents();
      const e = events.find((x) => x.id === String(id));
      if (!e || e.gh === gh) return false;
      e.gh = gh;
      await LGS.storage.setKey(K().EVENTS, events);
      return true;
    });
  }

  /** Merge problem metadata; never overwrite known values with empty ones. */
  function upsertProblems(list) {
    return prLock(async () => {
      const map = await loadProblems();
      for (const p of list) {
        if (!p || !p.slug) continue;
        const cur = map[p.slug] || { slug: p.slug };
        ['number', 'title', 'difficulty'].forEach((f) => { if (p[f]) cur[f] = p[f]; });
        if (p.topics && p.topics.length) cur.topics = p.topics;
        if (p.solved) cur.solved = true;
        map[p.slug] = cur;
      }
      await LGS.storage.setKey(K().PROBLEMS, map);
      return map;
    });
  }

  /** Records a finished live submission (any status). Returns the stored event. */
  async function recordLive(payload) {
    const p = payload.problem || {};
    const status = payload.status;
    const ok = status === A ? 1 : (status && status !== LGS.CONST.LEETCODE_STATUS.UNKNOWN_ERROR && !LGS.leetcode.status.isInProgress(status) ? 0 : null);
    const ev = {
      id: String(payload.submissionId || `live-${Date.now()}`), slug: p.slug, ts: Math.floor(Date.now() / 1000), ok,
      lang: langLabel(payload.language || p.language), ti: p.title || undefined
    };
    if (!ev.slug) return null;
    if (ok === 0) ev.st = status;
    if (ok === 1) { if (payload.runtime) ev.rt = payload.runtime; if (payload.memory) ev.mem = payload.memory; }
    await addEvents([ev]);
    if (ok === 1) await upsertProblems([{ slug: p.slug, number: p.number, title: p.title, difficulty: LGS.formatter.normalizeDifficulty(p.difficulty), topics: p.tags || p.topics, solved: true }]);
    return ev;
  }

  /** Has this problem ever been solved (per our records)? Used to tell a NEW solve from a re-solve. */
  async function isSolved(slug) {
    const [problems, events] = await Promise.all([loadProblems(), loadEvents()]);
    return !!((problems[slug] && problems[slug].solved) || events.some((e) => e.slug === slug && e.ok === 1));
  }

  /* ---------------- live submission status ---------------- */
  function setLive(patch, onlyIfId) {
    return liveLock(async () => {
      const cur = await LGS.storage.getKey(K().LIVE_SUBMISSION, null);
      if (onlyIfId && (!cur || String(cur.id) !== String(onlyIfId))) return cur;
      const next = Object.assign({}, cur || {}, patch, { updatedAt: Date.now() });
      await LGS.storage.setKey(K().LIVE_SUBMISSION, next);
      return next;
    });
  }
  const getLive = () => LGS.storage.getKey(K().LIVE_SUBMISSION, null);

  /* ---------------- snapshots ---------------- */
  async function getSnapshot() {
    const [events, problems, settings, lcStats, meta] = await Promise.all([
      loadEvents(), loadProblems(), LGS.storage.getSettings(), LGS.storage.getKey(K().LEETCODE_STATS, null), getMeta()
    ]);
    const snap = LGS.analytics.stats.compute(events, problems, { goal: settings.dailyGoal, leetcodeStats: lcStats, lastRefreshAt: meta.lastRefreshAt });
    snap.historyComplete = !!meta.historyComplete;
    snap.live = await getLive();
    return snap;
  }

  async function getProblemList(filters) {
    const [events, problems] = await Promise.all([loadEvents(), loadProblems()]);
    return LGS.analytics.stats.problemList(events, problems, filters || {});
  }

  async function clearAll() {
    await LGS.storage.remove([K().EVENTS, K().PROBLEMS, K().LIVE_SUBMISSION, K().STATS_META]);
  }

  LGS.analytics = LGS.analytics || {};
  LGS.analytics.store = {
    loadEvents, loadProblems, getMeta, setMeta, addEvents, addListItems, eventFromListItem, setEventGh,
    upsertProblems, recordLive, isSolved, setLive, getLive, getSnapshot, getProblemList, clearAll
  };
})(typeof self !== 'undefined' ? self : window);
