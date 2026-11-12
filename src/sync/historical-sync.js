/**
 * historical-sync.js  (src/sync/)
 *
 * "Sync Historical Accepted": back-fill every Accepted solution of the
 * account into GitHub. It only READS LeetCode - it never submits anything.
 *
 *   preflight  -> is the LeetCode session valid?
 *   solved     -> the account's own solved list (independent checklist)
 *   scanning   -> paginate the whole submission history (checkpointed)
 *   filling    -> per-problem lookup for solved problems the scan missed
 *   queue      -> one candidate per (problem, language), persisted
 *   syncing    -> for each candidate: fetch the submission DETAIL, VERIFY it
 *                 is Accepted, then hand it to syncSubmissionModel (which
 *                 re-checks Accepted again). Dry-run stops before any write.
 *   finalize   -> README + TOPICS.md written ONCE, stats refreshed
 *
 * Reliability model (MV3 service workers can die at any time):
 *   every phase persists its checkpoint; a 30s alarm "tick" notices a dead
 *   loop and resumes from the checkpoint automatically. Long rate limits
 *   park the job in 'waiting' and an alarm resumes it.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { MSG, STORAGE_KEYS, ACCEPTED_STATUS } = LGS.CONST;
  const F = LGS.formatter;
  const E = LGS.errors;
  const sleep = F.sleep;

  const queue = new LGS.sync.PersistedQueue(STORAGE_KEYS.HISTORICAL_QUEUE);
  const bridge = LGS.syncManager.createBridge('historical');
  const ACTIVE = new Set(['discovering', 'running']);
  const progressLock = F.createMutex();
  const reportLock = F.createMutex();
  const metaCache = new Map();

  let loopActive = false;
  let stopRequest = null; // null | 'pause' | 'cancel'

  /* ------------------------------ progress ------------------------------ */
  function freshProgress(patch) {
    return Object.assign({
      state: 'idle', mode: 'sync', onlyNew: false, phase: null,
      total: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skippedExisting: 0,
      notAccepted: 0, pendingDecision: 0, failed: 0, warnings: 0,
      current: null, startedAt: null, completedAt: null, error: null, errorCategory: null,
      waitUntil: null, resumeCount: 0, queueBuilt: false, discovery: {}, summary: null
    }, patch || {});
  }

  async function getProgress() {
    return (await LGS.storage.getHistoricalProgress()) || freshProgress();
  }

  function broadcast(progress) {
    try { chrome.runtime.sendMessage({ type: MSG.HISTORICAL_PROGRESS_UPDATED, payload: progress }, () => { void chrome.runtime.lastError; }); } catch (e) { /* no listener */ }
  }

  function setProgress(patch) {
    return progressLock(async () => {
      const next = Object.assign({}, await getProgress(), patch);
      await LGS.storage.setHistoricalProgress(next);
      broadcast(next);
      return next;
    });
  }

  function bump(field, n) {
    return progressLock(async () => {
      const cur = await getProgress();
      const next = Object.assign({}, cur, { [field]: (cur[field] || 0) + (n == null ? 1 : n) });
      if (field === 'processed') next.resumeCount = 0;
      await LGS.storage.setHistoricalProgress(next);
      broadcast(next);
      return next;
    });
  }

  /* ------------------------------ discovery state ------------------------------ */
  const loadDisc = () => LGS.storage.getKey(STORAGE_KEYS.HISTORICAL_DISCOVERY, null);
  const saveDisc = (d) => LGS.storage.setKey(STORAGE_KEYS.HISTORICAL_DISCOVERY, d);

  function newDisc(settings) {
    return {
      phase: 'scanning', startedAt: F.nowIso(), finishedAt: null,
      strategy: settings.historicalStrategy, maxCand: settings.maxCandidatesPerProblem,
      pageSize: settings.historicalPageSize,
      source: settings.discoverySource === 'auto' ? null : settings.discoverySource,
      offset: 0, lastKey: null, lastSig: null, pages: 0, emptyPages: 0, scanned: 0,
      byKey: {}, preflightDone: false, username: null,
      solved: null, solvedDone: false, solvedError: null,
      scanError: null, fillDone: [], fillErrors: [], unresolved: []
    };
  }

  function discSummary(d) {
    return {
      scanned: d.scanned, pages: d.pages, source: d.source,
      candidates: Object.keys(d.byKey).length,
      solvedTotal: d.solved ? d.solved.total : null,
      solvedListed: d.solved ? d.solved.items.length : null,
      unresolved: (d.unresolved || []).length,
      scanError: d.scanError, solvedError: d.solvedError
    };
  }

  /* ------------------------------ report ------------------------------ */
  function reportAdd(entry) {
    return reportLock(async () => {
      const rep = await LGS.storage.getKey(STORAGE_KEYS.HISTORICAL_REPORT, { startedAt: F.nowIso(), items: [] });
      if (rep.items.length < 3000) rep.items.push(entry);
      await LGS.storage.setKey(STORAGE_KEYS.HISTORICAL_REPORT, rep);
    });
  }

  const getReport = () => LGS.storage.getKey(STORAGE_KEYS.HISTORICAL_REPORT, null);

  /* ------------------------------ helpers ------------------------------ */
  function fatalError(err) {
    if (!err) return false;
    return ['LEETCODE_NOT_AUTHENTICATED', 'LEETCODE_BLOCKED', 'GITHUB_NOT_CONFIGURED'].includes(err.code)
      || !!err.longWait || !!err.fatalJob
      || err.code === 'LEETCODE_RATE_LIMITED' || err.code === 'GITHUB_RATE_LIMITED';
  }

  const logAttempt = (what) => (err, n) => LGS.logger.warn(`${what} failed (attempt ${n}):`, err.message);
  const retry = (fn, what) => LGS.sync.retry.withRetry(fn, { onAttemptFailed: logAttempt(what) });

  function ingest(disc, sub) {
    if (!sub || !sub.id || !sub.titleSlug) return;
    if (sub.isPending) return;
    // A KNOWN non-Accepted status is dropped; an UNKNOWN one is kept and verified later.
    if (sub.statusHint && sub.statusHint !== ACCEPTED_STATUS) return;
    const ext = LGS.languages.resolveLanguage(sub.lang || sub.langName).extension;
    const key = `${sub.titleSlug}::${ext}`;
    const slot = disc.byKey[key] || (disc.byKey[key] = { slug: sub.titleSlug, title: sub.title, lang: sub.lang, langName: sub.langName, ext, subs: [] });
    if (!slot.subs.some((s) => s.id === sub.id)) slot.subs.push({ id: sub.id, ts: sub.timestamp, h: sub.statusHint ? 1 : 0 });
    slot.subs.sort((a, b) => (disc.strategy === 'first' ? a.ts - b.ts : b.ts - a.ts));
    if (slot.subs.length > disc.maxCand) slot.subs.length = disc.maxCand;
  }

  /* ------------------------------ phase: discovery ------------------------------ */
  async function discover(settings) {
    let disc = await loadDisc();
    if (!disc) { disc = newDisc(settings); await saveDisc(disc); }
    const delay = settings.leetcodeRequestDelayMs;

    if (!disc.preflightDone) {
      await setProgress({ state: 'discovering', phase: 'preflight', current: 'Checking your LeetCode session…' });
      const auth = await retry(() => bridge.checkAuth(), 'auth check');
      if (auth && auth.isSignedIn === false) throw E.makeError('LEETCODE_NOT_AUTHENTICATED', 'You are not logged into LeetCode. Log in, then press Resume.');
      disc.username = (auth && auth.username) || null;
      disc.preflightDone = true;
      await saveDisc(disc);
    }

    if (!disc.solvedDone) {
      await setProgress({ phase: 'solved-list', current: 'Reading your solved-problems list…' });
      try {
        const s = await retry(() => bridge.listSolved(), 'solved list');
        disc.solved = { total: s.total, items: s.items };
      } catch (err) {
        if (fatalError(err)) throw err;
        disc.solvedError = err.message; // optional data: the scan can still work without it
        LGS.logger.warn('Solved list unavailable:', err.message);
      }
      disc.solvedDone = true;
      await saveDisc(disc);
    }

    if (disc.phase === 'scanning') {
      const r = await scanLoop(settings, disc, delay);
      if (r === 'stopped') return 'stopped';
    }
    if (disc.phase === 'filling') {
      const r = await fillLoop(settings, disc, delay);
      if (r === 'stopped') return 'stopped';
    }
    disc.phase = 'done';
    disc.finishedAt = F.nowIso();
    await saveDisc(disc);
    await setProgress({ discovery: discSummary(disc) });
    return 'done';
  }

  function endScan(disc) {
    disc.phase = disc.solved && disc.solved.items.length ? 'filling' : 'done';
  }

  async function scanLoop(settings, disc, delay) {
    while (true) {
      if (stopRequest) return 'stopped';
      if (disc.pages >= LGS.CONST.MAX_DISCOVERY_PAGES) {
        throw E.makeError('PAGINATION_STALLED', 'Stopped scanning: too many pages. LeetCode pagination may have changed.');
      }

      let page;
      try {
        page = await retry(() => bridge.listPage({
          offset: disc.offset, limit: disc.pageSize, lastKey: disc.lastKey, source: disc.source || settings.discoverySource
        }), 'submission list');
      } catch (err) {
        if (fatalError(err)) throw err;
        if (disc.pages === 0 && disc.pageSize > 20) { disc.pageSize = 20; await saveDisc(disc); continue; } // maybe the big limit was rejected
        disc.scanError = err.message;
        LGS.logger.warn('Full history scan unavailable, falling back to per-problem lookup:', err.message);
        if (!(disc.solved && disc.solved.items.length)) throw err;
        endScan(disc);
        break;
      }

      disc.source = page.source;
      const raw = page.rawCount != null ? page.rawCount : page.submissions.length;

      if (raw === 0) {
        disc.emptyPages++;
        if (page.hasNext && disc.emptyPages < 3) { await sleep(delay); continue; }
        endScan(disc);
        break;
      }
      disc.emptyPages = 0;

      // Pagination protection (review item 5): the same page twice means it is not advancing.
      const sig = page.submissions.slice(0, 3).map((s) => s.id).join(',') + '|' + raw;
      if (sig === disc.lastSig) {
        throw E.makeError('PAGINATION_STALLED', 'LeetCode returned the same page twice - pagination is not advancing. Aborted to avoid an endless loop.');
      }
      disc.lastSig = sig;

      page.submissions.forEach((s) => ingest(disc, s));
      // The same scan also feeds the progress dashboard (accepted AND failed attempts).
      try { await LGS.analytics.store.addListItems(page.submissions); } catch (e) { LGS.logger.warn('Could not record activity from scan:', e.message); }
      disc.scanned += raw;
      disc.offset += raw; // advance by what the server REALLY returned, not what we asked for
      disc.pages++;
      if (page.lastKey) disc.lastKey = page.lastKey;
      await saveDisc(disc); // checkpoint (review item 11)
      await setProgress({
        phase: 'scanning',
        current: `Scanned ${disc.scanned} submissions - ${Object.keys(disc.byKey).length} problem/language candidates so far…`,
        discovery: discSummary(disc)
      });

      if (!page.hasNext) { endScan(disc); break; }
      await sleep(delay);
    }
    await saveDisc(disc);
    return 'ok';
  }

  async function fillLoop(settings, disc, delay) {
    const covered = new Set(Object.values(disc.byKey).map((s) => s.slug));
    const todo = disc.solved.items.map((i) => i.slug).filter((s) => disc.scanError || !covered.has(s));
    const done = new Set(disc.fillDone);
    let n = 0;
    for (const slug of todo) {
      n++;
      if (done.has(slug)) continue;
      if (stopRequest) { await saveDisc(disc); return 'stopped'; }
      await setProgress({ phase: 'filling', current: `Looking up submissions for ${slug} (${n}/${todo.length})…` });
      try {
        const subs = await retry(() => bridge.listForSlug(slug, { limit: 20, maxPages: 5, source: disc.source || settings.discoverySource }), `lookup ${slug}`);
        subs.forEach((s) => ingest(disc, s));
      } catch (err) {
        if (fatalError(err)) { await saveDisc(disc); throw err; }
        disc.fillErrors.push(slug);
        LGS.logger.warn('Per-problem lookup failed for', slug, err.message);
      }
      disc.fillDone.push(slug);
      if (n % 5 === 0) await saveDisc(disc);
      await sleep(delay);
    }
    const have = new Set(Object.values(disc.byKey).map((s) => s.slug));
    disc.unresolved = disc.solved.items.map((i) => i.slug).filter((s) => !have.has(s));
    await saveDisc(disc);
    return 'ok';
  }

  /* ------------------------------ phase: queue ------------------------------ */
  function buildCandidates(disc) {
    const meta = {};
    ((disc.solved && disc.solved.items) || []).forEach((i) => { meta[i.slug] = i; });
    return Object.entries(disc.byKey).map(([key, s]) => ({
      key, slug: s.slug, title: s.title, lang: s.lang, langName: s.langName, ext: s.ext,
      subs: s.subs.slice(),
      meta: meta[s.slug] ? { number: meta[s.slug].number, difficulty: meta[s.slug].difficulty, title: meta[s.slug].title, topics: meta[s.slug].topics } : {}
    })).sort((a, b) => (parseInt(a.meta.number, 10) || 1e9) - (parseInt(b.meta.number, 10) || 1e9) || a.key.localeCompare(b.key));
  }

  async function buildQueue(progress) {
    const disc = await loadDisc();
    const index = await LGS.sync.indexStore.load();
    let items = buildCandidates(disc);
    const found = items.length;
    if (progress.onlyNew) items = items.filter((i) => !LGS.sync.indexStore.has(index, i.slug, i.ext));
    await queue.clear();
    await queue.pushMany(items);
    await setProgress({ queueBuilt: true, total: items.length, discovery: Object.assign(discSummary(disc), { candidates: found, skippedAlreadyInRepo: found - items.length }) });
  }

  /* ------------------------------ phase: process ------------------------------ */
  async function resolveMeta(detail, item) {
    const dq = detail.question || {};
    const m = item.meta || {};
    let number = dq.frontendId || m.number || null;
    let difficulty = dq.difficulty || m.difficulty || null;
    let title = dq.title || m.title || item.title || null;
    let tags = (dq.topicTags && dq.topicTags.length) ? dq.topicTags : (m.topics || []);
    const slug = dq.titleSlug || item.slug;
    if ((!number || !difficulty) && slug) {
      let q = metaCache.get(slug);
      if (!q) {
        q = await retry(() => bridge.getQuestionMeta(slug), `metadata ${slug}`);
        if (q) metaCache.set(slug, q);
      }
      if (q) {
        number = number || q.number; difficulty = difficulty || q.difficulty;
        title = title || q.title; if (!tags.length) tags = q.tags || [];
      }
    }
    return { number, difficulty, title, slug, tags };
  }

  async function processItem(item, ctx) {
    const delay = ctx.settings.leetcodeRequestDelayMs;
    let lastVerdict = null;

    for (const sub of item.subs) {
      const detail = await retry(() => bridge.getDetail(sub.id), `detail ${sub.id}`);
      const verdict = LGS.leetcode.status.verifyAccepted(sub.h ? ACCEPTED_STATUS : null, detail);
      lastVerdict = verdict;
      if (!verdict.accepted) { await sleep(delay); continue; }

      if (!detail || !detail.code || !detail.code.trim()) {
        throw E.makeError('LEETCODE_MISSING_CODE', 'LeetCode did not return code for this submission.');
      }
      const meta = await resolveMeta(detail, item);
      const model = LGS.leetcode.metadata.buildSubmissionModel({
        submissionId: sub.id,
        problem: { number: meta.number, title: meta.title, slug: meta.slug, difficulty: meta.difficulty, tags: meta.tags, url: `https://leetcode.com/problems/${meta.slug}/` },
        rawLanguage: detail.langName || detail.langSlug || item.langName || item.lang,
        code: detail.code,
        status: ACCEPTED_STATUS, // verified just above; syncSubmissionModel re-checks anyway
        runtime: detail.runtime || null,
        memory: detail.memory || null,
        timestamp: (sub.ts || 0) * 1000 || Date.now()
      });
      try { await LGS.analytics.store.upsertProblems([{ slug: meta.slug, number: meta.number, title: meta.title, difficulty: model.difficulty, topics: meta.tags, solved: true }]); } catch (e) { /* stats are best-effort */ }
      const record = await LGS.sync.currentSync.syncSubmissionModel(model, {
        source: 'historical', session: ctx.session, deferReadme: true, dryRun: ctx.dryRun, quiet: true
      });
      return { record, model, verifiedBy: verdict.source };
    }
    return { action: 'not-accepted', reason: lastVerdict ? (lastVerdict.status || 'status could not be verified') : 'no submissions to check' };
  }

  const OUTCOME_FIELD = {
    'created': 'created', 'would-create': 'created',
    'updated': 'updated', 'would-update': 'updated',
    'unchanged': 'unchanged',
    'skipped-existing': 'skippedExisting', 'would-skip-existing': 'skippedExisting',
    'pending-decision': 'pendingDecision', 'would-ask': 'pendingDecision',
    'not-accepted': 'notAccepted'
  };

  async function countOutcome(result, item) {
    const action = result.record ? result.record.action : result.action;
    const field = OUTCOME_FIELD[action];
    if (field) await bump(field);
    if (result.model && result.model.languageUnknown) await bump('warnings');
    await reportAdd({
      slug: item.slug, title: result.model ? result.model.title : item.title,
      lang: result.model ? result.model.language : (item.langName || item.lang),
      path: result.record ? result.record.githubPath : null,
      outcome: action, reason: result.reason || null
    });
  }

  async function recordFailure(item, err, c) {
    LGS.logger.error('Historical item failed:', item.slug, err.message);
    await LGS.sync.retry.addToRetryList({
      kind: 'historical', candidate: item, title: item.title || item.slug, slug: item.slug, language: item.langName || item.lang,
      error: err.message, category: c.category, retryable: c.autoRetry, failedAt: F.nowIso()
    });
    await reportAdd({ slug: item.slug, title: item.title, lang: item.langName || item.lang, path: null, outcome: 'failed', reason: `${c.label}: ${err.message}` });
  }

  async function processQueue(ctx) {
    await queue.load();
    const delay = ctx.settings.leetcodeRequestDelayMs;
    while (true) {
      if (stopRequest) return 'stopped';
      const item = await queue.peek();
      if (!item) return 'empty';
      await setProgress({ phase: 'syncing', current: `${item.slug} (${item.langName || item.lang})` });

      let result = null;
      try {
        result = await processItem(item, ctx);
        ctx.permFails = 0;
      } catch (err) {
        if (fatalError(err)) throw err; // item stays at the head of the queue
        const c = E.classify(err);
        ctx.permFails = (c.category === 'permission' || c.category === 'config') ? ctx.permFails + 1 : 0;
        await recordFailure(item, err, c);
        await bump('failed');
        if (ctx.permFails >= 3) {
          await queue.removeHead(); await bump('processed');
          err.fatalJob = true;
          err.message = `Stopped after repeated GitHub permission/configuration errors: ${err.message}`;
          throw err;
        }
      }
      if (result) await countOutcome(result, item);
      await queue.removeHead();
      await bump('processed');
      await sleep(delay);
    }
  }

  /* ------------------------------ finalize / errors ------------------------------ */
  async function finalize(ctx, settings) {
    if (!ctx.dryRun) {
      await setProgress({ phase: 'finalizing', current: 'Verifying your solved count and updating the README…' });
      try {
        const s = await bridge.getSolvedStats();
        if (s) await LGS.storage.setKey(STORAGE_KEYS.LEETCODE_STATS, Object.assign({}, s, { fetchedAt: F.nowIso() }));
      } catch (err) {
        if (err.code === 'LEETCODE_NOT_AUTHENTICATED') LGS.logger.warn('Could not verify solved count:', err.message);
      }
      if (settings.updateRepoReadme) {
        try { await LGS.sync.publisher.publishMainReadme(ctx.session); }
        catch (err) { LGS.logger.warn('Final README update failed:', err.message); await bump('warnings'); }
      }
    }
    const p = await getProgress();
    const summary = `${ctx.dryRun ? 'Dry run' : 'Sync'} finished: ${p.created} new, ${p.updated} updated, ${p.unchanged} unchanged, ${p.skippedExisting} kept, ${p.pendingDecision} awaiting decision, ${p.notAccepted} not accepted, ${p.failed} failed.`;
    await setProgress({ state: 'completed', phase: null, completedAt: F.nowIso(), current: null, error: null, errorCategory: null, summary });
    await LGS.syncManager.closeOpenedTabs();
    if (settings.notifications && !ctx.dryRun) {
      try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Historical sync finished', message: summary }); } catch (e) { /* ignore */ }
    }
  }

  async function finishStopped() {
    const req = stopRequest;
    stopRequest = null;
    if (req === 'cancel') {
      await queue.clear();
      await LGS.storage.remove(STORAGE_KEYS.HISTORICAL_DISCOVERY);
      await LGS.syncManager.closeOpenedTabs();
      return setProgress({ state: 'cancelled', phase: null, current: null, queueBuilt: false, error: null });
    }
    return setProgress({ state: 'paused', current: null, error: null, errorCategory: null });
  }

  async function handleJobError(err) {
    const c = E.classify(err);
    LGS.logger.error('Historical sync stopped:', c.category, err.message);

    if (err.longWait || err.code === 'GITHUB_RATE_LIMITED' || err.code === 'LEETCODE_RATE_LIMITED') {
      const wait = Math.max(err.waitMs || E.waitMsFor(err), 60000);
      const until = Date.now() + wait;
      LGS.scheduler.wakeAt(until);
      await setProgress({
        state: 'waiting', waitUntil: until, errorCategory: 'rate_limit',
        error: `Rate limited - resuming automatically at ${new Date(until).toLocaleTimeString()}. Nothing is lost.`
      });
      return;
    }
    if (c.category === 'auth' || c.category === 'blocked') {
      await setProgress({
        state: 'paused', errorCategory: c.category,
        error: c.category === 'blocked'
          ? err.message
          : 'Please log into LeetCode (in any tab), then press Resume. The extension never needs your LeetCode password.'
      });
      return;
    }
    await setProgress({ state: 'error', error: err.message || String(err), errorCategory: c.category });
  }

  /* ------------------------------ job runner ------------------------------ */
  async function runJob() {
    if (loopActive) return;
    loopActive = true;
    LGS.scheduler.startKeepAlive();
    LGS.scheduler.ensureTick(true);
    try {
      let progress = await getProgress();
      const settings = await LGS.storage.getSettings();
      LGS.logger.setDebugEnabled(settings.debugLogging);
      const config = await LGS.github.auth.loadConfig();
      if (!config) throw E.makeError('GITHUB_NOT_CONFIGURED', 'GitHub is not configured yet. Open Settings to connect a repository.');

      if (!progress.queueBuilt) {
        await setProgress({ state: 'discovering', error: null, errorCategory: null, waitUntil: null });
        if ((await discover(settings)) === 'stopped') { await finishStopped(); return; }
        progress = await getProgress();
        await buildQueue(progress);
        progress = await getProgress();
      }

      await setProgress({ state: 'running', phase: 'syncing', error: null, errorCategory: null, waitUntil: null, current: 'Reading your GitHub repository…' });
      const dryRun = progress.mode === 'dry-run';
      const session = new LGS.github.GithubSession(config, { writeDelayMs: dryRun ? 0 : settings.githubWriteDelayMs });
      const tree = await session.loadTree();
      if (tree.truncated) LGS.logger.warn('Repository tree is truncated; falling back to per-file lookups (slower).');

      const ctx = { settings, session, dryRun, permFails: 0 };
      if ((await processQueue(ctx)) === 'stopped') { await finishStopped(); return; }
      await finalize(ctx, settings);
    } catch (err) {
      await handleJobError(err);
    } finally {
      loopActive = false;
      LGS.scheduler.stopKeepAlive();
      const p = await getProgress();
      if (!ACTIVE.has(p.state) && p.state !== 'waiting') LGS.scheduler.ensureTick(false);
    }
  }

  function launch() {
    runJob().catch((err) => {
      LGS.logger.error('Unhandled historical sync error:', err.message);
      setProgress({ state: 'error', error: err.message || String(err) });
    });
  }

  /* ------------------------------ public API ------------------------------ */
  async function start(opts = {}) {
    const progress = await getProgress();
    if (loopActive || ACTIVE.has(progress.state)) return progress;

    const config = await LGS.github.auth.loadConfig();
    if (!config) {
      return setProgress(freshProgress({ state: 'error', error: 'GitHub is not configured yet. Open Settings to connect a repository.' }));
    }
    const settings = await LGS.storage.getSettings();

    const disc = await loadDisc();
    const fresh = disc && disc.phase === 'done' && disc.finishedAt
      && (Date.now() - Date.parse(disc.finishedAt)) < LGS.CONST.JOB_STALE_DISCOVERY_MS
      && disc.strategy === settings.historicalStrategy && disc.maxCand === settings.maxCandidatesPerProblem;
    const reuse = opts.reuseDiscovery !== false && !!fresh;
    if (!reuse) await LGS.storage.remove(STORAGE_KEYS.HISTORICAL_DISCOVERY);

    stopRequest = null;
    await queue.clear();
    await LGS.storage.setKey(STORAGE_KEYS.HISTORICAL_REPORT, { startedAt: F.nowIso(), mode: opts.dryRun ? 'dry-run' : 'sync', items: [] });
    await LGS.sync.retry.removeFromRetryList((i) => i.kind === 'historical');

    const next = freshProgress({
      state: reuse ? 'running' : 'discovering', mode: opts.dryRun ? 'dry-run' : 'sync', onlyNew: !!opts.onlyNew,
      phase: reuse ? 'syncing' : 'preflight', startedAt: F.nowIso(),
      current: reuse ? 'Reusing the scan from a few minutes ago…' : 'Scanning your LeetCode submission history…'
    });
    await LGS.storage.setHistoricalProgress(next);
    broadcast(next);
    launch();
    return next;
  }

  async function pause() {
    stopRequest = 'pause';
    const p = await getProgress();
    if (!loopActive && (ACTIVE.has(p.state) || p.state === 'waiting')) { stopRequest = null; return setProgress({ state: 'paused', current: null, error: null }); }
    return p;
  }

  async function resume() {
    const p = await getProgress();
    if (loopActive) return p;
    if (!['paused', 'waiting', 'error'].includes(p.state)) return p;
    stopRequest = null;
    LGS.scheduler.clearWake();
    const disc = await loadDisc();
    const next = await setProgress({ state: disc && disc.phase !== 'done' && !p.queueBuilt ? 'discovering' : 'running', error: null, errorCategory: null, waitUntil: null });
    launch();
    return next;
  }

  async function cancel() {
    stopRequest = 'cancel';
    const p = await getProgress();
    if (!loopActive) return finishStopped();
    return p;
  }

  async function retryFailed({ mode = 'recoverable', ids = null } = {}) {
    const list = await LGS.storage.getRetryList();
    const picked = list.filter((i) => (ids ? ids.includes(i.id) : (mode === 'all' || i.retryable)));
    if (!picked.length) return { progress: await getProgress(), retried: 0, modelOk: 0, errors: [] };

    const modelItems = picked.filter((i) => i.kind === 'model');
    const histItems = picked.filter((i) => i.kind === 'historical');
    let modelOk = 0; let errors = [];
    if (modelItems.length) { const r = await LGS.sync.currentSync.retryModelItems(modelItems); modelOk = r.ok; errors = r.errors; }

    if (histItems.length) {
      await LGS.sync.retry.removeFromRetryList((i) => histItems.some((h) => h.id === i.id));
      await queue.load();
      await queue.pushMany(histItems.map((h) => h.candidate));
      const p = await getProgress();
      if (loopActive || ACTIVE.has(p.state)) {
        await setProgress({ total: p.total + histItems.length, failed: Math.max(0, p.failed - histItems.length) });
      } else {
        stopRequest = null;
        await setProgress({
          state: 'running', mode: 'sync', queueBuilt: true, total: p.total + histItems.length,
          failed: Math.max(0, p.failed - histItems.length), completedAt: null, error: null, errorCategory: null
        });
        launch();
      }
    }
    return { progress: await getProgress(), retried: histItems.length, modelOk, errors };
  }

  /** Called by the 30s alarm, by the wake alarm, and once at worker start. */
  async function tick() {
    if (loopActive) return;
    const p = await getProgress();
    if (p.state === 'waiting') {
      if (p.waitUntil && Date.now() >= p.waitUntil) { stopRequest = null; await setProgress({ state: 'running', error: null, waitUntil: null }); launch(); }
      return;
    }
    if (ACTIVE.has(p.state)) {
      // The state says "working" but no loop exists in this worker: it was killed. Resume from the checkpoint.
      queue.invalidate();
      if ((p.resumeCount || 0) >= LGS.CONST.MAX_AUTO_RESUMES) {
        await setProgress({ state: 'paused', error: 'The sync was interrupted too many times. Press Resume to continue.' });
        return;
      }
      LGS.logger.warn('Historical sync loop was not running - resuming from checkpoint.');
      await setProgress({ resumeCount: (p.resumeCount || 0) + 1 });
      launch();
      return;
    }
    LGS.scheduler.ensureTick(false);
    if (p.state !== 'paused') await LGS.syncManager.closeOpenedTabs();
  }

  const getFailedItems = () => LGS.storage.getRetryList();
  async function clearFailed() { await LGS.sync.retry.clearRetryList(); return setProgress({ failed: 0 }); }
  async function resetAll() {
    stopRequest = null;
    await queue.clear();
    await LGS.storage.remove([STORAGE_KEYS.HISTORICAL_DISCOVERY, STORAGE_KEYS.HISTORICAL_REPORT]);
    await LGS.storage.setHistoricalProgress(freshProgress());
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.historicalSync = {
    start, pause, resume, cancel, retryFailed, tick, getProgress, getReport, getFailedItems, clearFailed, resetAll,
    isRunning: () => loopActive
  };
})(typeof self !== 'undefined' ? self : window);
