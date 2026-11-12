/**
 * message-handler.js  (src/background/)
 *
 * Every chrome.runtime.onMessage for the service worker funnels through
 * here. This is the boundary where LeetCode data (from content scripts) and
 * GitHub credentials (from storage) meet - content scripts and UI pages
 * never receive the token.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { MSG, ACCEPTED_STATUS, STORAGE_KEYS } = LGS.CONST;

  function notify(title, message) {
    try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }); } catch (e) { /* ignore */ }
  }

  function broadcastHistoryUpdated() {
    try { chrome.runtime.sendMessage({ type: MSG.SYNC_HISTORY_UPDATED }, () => { void chrome.runtime.lastError; }); } catch (e) { /* no listener */ }
  }

  /**
   * After a confirmed solve, the stored LeetCode solved counts must reflect it - otherwise the README's
   * "Solved on LeetCode" column would lag behind "Synced to GitHub". Prefer LeetCode's fresh numbers;
   * if they are missing, or LeetCode has not caught up yet, add the new solve to the stored ones.
   */
  async function updateLeetcodeCounts(payload, problem, wasSolved) {
    const key = STORAGE_KEYS.LEETCODE_STATS;
    const prev = await LGS.storage.getKey(key, null);
    const fresh = payload.leetcodeStats && payload.leetcodeStats.all != null ? payload.leetcodeStats : null;
    let next = null;
    if (fresh && (wasSolved || !prev || fresh.all > prev.all)) next = fresh;           // LeetCode's own numbers
    else if (!wasSolved && prev) {                                                      // new solve, LeetCode lagging / unavailable
      const d = LGS.formatter.normalizeDifficulty(problem.difficulty);
      next = Object.assign({}, prev, { all: prev.all + 1 });
      if (d) next[d.toLowerCase()] = (prev[d.toLowerCase()] || 0) + 1;
    } else if (fresh) next = fresh;
    if (next) await LGS.storage.setKey(key, Object.assign({}, next, { fetchedAt: LGS.formatter.nowIso() }));
  }

  /** Live progress ("Checking submission…") reported while the judge is running. */
  async function handleSubmissionStatus(payload, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return { ok: false };
    const p = payload || {};
    await LGS.analytics.store.setLive({
      id: p.submissionId || `pending-${p.slug}`, slug: p.slug, title: p.title || null,
      lc: 'checking', lcDetail: p.status || null, gh: 'none', ghError: null
    });
    return { ok: true };
  }

  /**
   * Final result of a submission (ANY status). Order matters:
   *   1. record it as activity            -> LeetCode progress is updated at once
   *   2. only if Accepted: queue the GitHub save (persisted, auto-retried)
   * A GitHub problem can therefore never make a solved problem look unsolved.
   */
  async function handleSubmissionResult(payload, sender) {
    // Only our own content scripts, running on leetcode.com, may report results.
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab) return { synced: false, error: 'Untrusted sender' };

    const status = payload.status;
    const p = payload.problem || {};
    const settings = await LGS.storage.getSettings();
    const accepted = status === ACCEPTED_STATUS;
    const subId = payload.submissionId ? String(payload.submissionId) : null;

    const wasSolved = accepted && p.slug ? await LGS.analytics.store.isSolved(p.slug).catch(() => true) : true;
    let event = null;
    try { event = await LGS.analytics.store.recordLive(payload); }
    catch (err) { LGS.logger.error('Could not record activity:', err.message); }

    await LGS.analytics.store.setLive({
      id: subId || (event && event.id) || `r-${Date.now()}`, slug: p.slug, title: p.title || null, number: p.number || null,
      difficulty: p.difficulty || null, topics: p.tags || [], language: payload.language || p.language || null,
      lc: status, lcDetail: null, runtime: payload.runtime || null, memory: payload.memory || null,
      gh: 'none', ghError: null
    });

    if (!accepted) {
      LGS.logger.info('Submission finished with non-Accepted status, nothing uploaded:', status);
      if (settings.notifications) {
        notify('LeetCode submission not accepted', `${p.title ? p.title + ': ' : ''}${status}\n\nNothing was uploaded to GitHub.`);
      }
      return { synced: false, status, recorded: !!event };
    }

    // Keep "Solved on LeetCode" (used by the README) current: use LeetCode's fresh counts, or bump ours.
    try { await updateLeetcodeCounts(payload, p, wasSolved); } catch (err) { LGS.logger.warn('Could not update LeetCode counts:', err.message); }

    const cfg = await LGS.github.auth.loadConfig();
    const liveId = subId || (event && event.id);
    if (payload.solvedState === 'not-solved') { // LeetCode has not confirmed the solve: save nothing
      await LGS.analytics.store.setLive({ gh: 'none' }, liveId);
      return { synced: false, status, recorded: true, error: 'LeetCode has not confirmed this problem as solved' };
    }
    if (!settings.autoSync || !cfg) {
      if (event) await LGS.analytics.store.setEventGh(event.id, 'off');
      await LGS.analytics.store.setLive({ gh: 'off' }, liveId);
      return { synced: false, status, recorded: true, autoSyncDisabled: !settings.autoSync };
    }
    if (!payload.code) {
      if (event) await LGS.analytics.store.setEventGh(event.id, 'failed');
      await LGS.analytics.store.setLive({ gh: 'failed', ghError: 'LeetCode did not return the code' }, liveId);
      return { synced: false, status, recorded: true, error: 'Missing code' };
    }

    try {
      const model = LGS.leetcode.metadata.buildSubmissionModel({
        submissionId: payload.submissionId, problem: p,
        rawLanguage: payload.language || p.language,
        code: payload.code, status, runtime: payload.runtime, memory: payload.memory, timestamp: Date.now()
      });
      await LGS.sync.saveQueue.enqueue(model);          // persisted first ...
      const r = await LGS.sync.saveQueue.processDue();   // ... then attempted now
      broadcastHistoryUpdated();
      return { synced: !!(r && r.done), recorded: true, queued: true, status };
    } catch (err) {
      LGS.logger.error('Could not queue GitHub save:', err.message);
      await LGS.analytics.store.setLive({ gh: 'failed', ghError: err.message }, liveId);
      return { synced: false, status, recorded: true, error: err.message };
    }
  }

  async function handleGetState() {
    const [githubConfig, settings, history, progress, retryList, pending, index, lcStats, failedSaves, pendingSaves] = await Promise.all([
      LGS.github.auth.loadConfig(),
      LGS.storage.getSettings(),
      LGS.storage.getSyncHistory(),
      LGS.sync.historicalSync.getProgress(),
      LGS.storage.getRetryList(),
      LGS.sync.decisions.list(),
      LGS.sync.indexStore.load(),
      LGS.storage.getKey(STORAGE_KEYS.LEETCODE_STATS, null),
      LGS.sync.saveQueue.failedCount(),
      LGS.sync.saveQueue.pendingCount()
    ]);
    const s = LGS.sync.indexStore.stats(index);
    return {
      version: LGS.CONST.VERSION,
      githubConfig: LGS.github.auth.publicView(githubConfig),
      settings,
      recentHistory: history.slice(0, 30),
      totalSynced: s.problems,
      totalFiles: s.files,
      byDifficulty: s.byDifficulty,
      byLanguage: s.byLanguage,
      historicalProgress: progress,
      retryCount: retryList.length + failedSaves,
      pendingSaves,
      failedSaves,
      pendingDecisions: pending.length,
      leetcodeStats: lcStats
    };
  }

  async function handleSaveGithubConfig(payload) {
    const saved = await LGS.github.auth.saveConfig(payload || {});
    LGS.sync.saveQueue.retry('all').catch(() => {}); // a fixed token/repo should flush any waiting saves
    return { config: LGS.github.auth.publicView(saved) };
  }

  async function handleTestConnection(payload) {
    const saved = await LGS.github.auth.loadConfig();
    const p = payload || {};
    const config = {
      owner: (p.owner || (saved && saved.owner) || '').trim(),
      repo: (p.repo || (saved && saved.repo) || '').trim(),
      branch: (p.branch || (saved && saved.branch) || 'main').trim(),
      token: (p.token && p.token.trim()) || (saved && saved.token) || ''
    };
    if (!config.token) return { ok: false, message: 'No token to test. Paste a token first.' };
    return LGS.github.repository.testConnection(config);
  }

  async function wrapAction(fn) {
    try {
      const data = await fn();
      broadcastHistoryUpdated();
      return Object.assign({ ok: true }, data);
    } catch (err) {
      return { ok: false, message: err.message, code: err.code, category: LGS.errors.classify(err).category };
    }
  }

  async function handleGetLogs() {
    const all = await LGS.storage.get([STORAGE_KEYS.DEBUG_LOG_PREFIX + 'bg', STORAGE_KEYS.DEBUG_LOG_PREFIX + 'page']);
    const merged = [].concat(all[STORAGE_KEYS.DEBUG_LOG_PREFIX + 'bg'] || [], all[STORAGE_KEYS.DEBUG_LOG_PREFIX + 'page'] || [], LGS.logger.getBuffer());
    const seen = new Set();
    return merged.filter((e) => { const k = e.time + e.message; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 300);
  }

  async function handleResetLocalData() {
    const p = await LGS.sync.historicalSync.getProgress();
    if (LGS.sync.historicalSync.isRunning() || ['discovering', 'running'].includes(p.state)) {
      throw LGS.errors.makeError('SYNC_REFUSED', 'Cancel the running historical sync first.', { reason: 'metadata' });
    }
    await LGS.storage.remove([
      STORAGE_KEYS.SYNC_HISTORY, STORAGE_KEYS.SOLUTION_INDEX, STORAGE_KEYS.PENDING_DECISIONS,
      STORAGE_KEYS.SYNCED_SUBMISSION_IDS, STORAGE_KEYS.RETRY_LIST, STORAGE_KEYS.LEETCODE_STATS, STORAGE_KEYS.DIAGNOSTICS
    ]);
    await LGS.analytics.store.clearAll();
    await LGS.storage.remove([STORAGE_KEYS.SAVE_QUEUE]);
    await LGS.sync.historicalSync.resetAll();
    return { reset: true };
  }

  function dispatch(message, sender, sendResponse) {
    const respond = (promise) => {
      Promise.resolve(promise)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => {
          LGS.logger.error('Message handler error for', message.type, err.message);
          sendResponse({ ok: false, error: err.message, code: err.code });
        });
      return true;
    };
    const p = message.payload;
    const H = () => LGS.sync.historicalSync;

    switch (message.type) {
      case MSG.CONTENT_READY:
        // A LeetCode page just loaded: refresh stats quietly (throttled) and flush queued saves.
        LGS.analytics.statsSync.refresh({}).catch((e) => LGS.logger.warn('stats refresh failed:', e.message));
        LGS.sync.saveQueue.processDue().catch(() => {});
        sendResponse({ ok: true });
        return false;
      case MSG.SUBMISSION_STATUS: return respond(handleSubmissionStatus(p || {}, sender));
      case MSG.SUBMISSION_RESULT: return respond(handleSubmissionResult(p || {}, sender));

      case MSG.GET_STATE: return respond(handleGetState());
      case MSG.SAVE_GITHUB_CONFIG: return respond(handleSaveGithubConfig(p));
      case MSG.CLEAR_GITHUB_CONFIG: return respond(LGS.github.auth.clearConfig().then(() => ({ cleared: true })));
      case MSG.TEST_GITHUB_CONNECTION: return respond(handleTestConnection(p));
      case MSG.SAVE_SETTINGS:
        return respond(LGS.storage.setSettings(p).then((settings) => { LGS.logger.setDebugEnabled(settings.debugLogging); return { settings }; }));
      case MSG.GET_SETTINGS: return respond(LGS.storage.getSettings());

      case MSG.SYNC_CURRENT:
        return respond(wrapAction(async () => ({ record: await LGS.sync.currentSync.syncCurrent() })));
      case MSG.SYNC_PROBLEM:
        return respond(wrapAction(async () => ({ record: await LGS.sync.currentSync.syncProblem(p && p.slug, { source: 'current' }) })));

      case MSG.SYNC_HISTORICAL_START: return respond(H().start(p || {}));
      case MSG.SYNC_HISTORICAL_PAUSE: return respond(H().pause());
      case MSG.SYNC_HISTORICAL_RESUME: return respond(H().resume());
      case MSG.SYNC_HISTORICAL_CANCEL: return respond(H().cancel());
      case MSG.GET_HISTORICAL_PROGRESS: return respond(H().getProgress());
      case MSG.GET_HISTORICAL_REPORT: return respond(H().getReport());
      case MSG.RETRY_FAILED: return respond(H().retryFailed(p || {}));
      case MSG.GET_FAILED_ITEMS:
        return respond(Promise.all([H().getFailedItems(), LGS.sync.saveQueue.list()]).then(([l, q]) => l.map(({ candidate, model, ...rest }) => rest).concat(
          q.filter((i) => i.state === 'failed').map((i) => ({ id: i.id, kind: 'save', title: i.title, slug: i.slug, language: i.language, error: i.lastError || 'GitHub save failed', category: 'permission_or_unknown', retryable: false, failedAt: new Date(i.createdAt).toISOString() })))));
      case MSG.RETRY_SAVE: return respond(LGS.sync.saveQueue.retry((p && p.id) || 'all'));
      case MSG.GET_STATS:
        // Return the cached numbers immediately; refresh in the background without opening any tab.
        LGS.analytics.statsSync.refresh({}).catch(() => {});
        return respond(LGS.analytics.store.getSnapshot());
      case MSG.GET_PROBLEMS: return respond(LGS.analytics.store.getProblemList(p || {}));
      case MSG.REFRESH_STATS:
        return respond(wrapAction(async () => ({ result: await LGS.analytics.statsSync.refresh({ force: (p && p.full) ? 'full' : true, allowOpen: true }) })));
      case MSG.CLEAR_FAILED_ITEMS: return respond(H().clearFailed());

      case MSG.GET_PENDING_DECISIONS: return respond(LGS.sync.decisions.listPublic());
      case MSG.RESOLVE_DECISION:
        return respond(wrapAction(() => LGS.sync.decisions.resolve(p.id, p.action)));

      case MSG.REBUILD_INDEX: return respond(wrapAction(async () => ({ result: await LGS.sync.repoTools.rebuildIndex() })));
      case MSG.REGENERATE_READMES: return respond(wrapAction(async () => ({ result: await LGS.sync.repoTools.regenerateReadmes(p || {}) })));
      case MSG.VERIFY_COVERAGE: return respond(wrapAction(async () => ({ result: await LGS.sync.repoTools.verifyCoverage() })));
      case MSG.GET_INDEX: return respond(LGS.sync.repoTools.getIndexView());

      case MSG.RUN_DIAGNOSTICS: return respond(LGS.sync.diagnostics.run());
      case MSG.GET_LOGS: return respond(handleGetLogs());
      case MSG.CLEAR_LOGS:
        return respond(LGS.storage.remove([STORAGE_KEYS.DEBUG_LOG_PREFIX + 'bg', STORAGE_KEYS.DEBUG_LOG_PREFIX + 'page']).then(() => ({ cleared: true })));
      case MSG.RESET_LOCAL_DATA: return respond(handleResetLocalData());
      case MSG.GET_SYNC_HISTORY: return respond(LGS.storage.getSyncHistory());

      case MSG.OPEN_DASHBOARD: {
        const hash = p && p.tab ? `#${p.tab}${p.topic ? '?topic=' + encodeURIComponent(p.topic) : ''}` : '';
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') + hash });
        sendResponse({ ok: true });
        return false;
      }
      default: return false;
    }
  }

  LGS.messageHandler = { dispatch };
})(typeof self !== 'undefined' ? self : window);
