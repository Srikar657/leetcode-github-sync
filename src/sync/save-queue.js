/**
 * save-queue.js  (src/sync/)
 *
 * The GitHub save queue. LeetCode progress and GitHub saving are SEPARATE
 * states: an Accepted submission is recorded (solved, streak, stats) the
 * moment it is detected; saving it to GitHub is a queued job that can
 * wait, retry and even fail without ever making the problem "unsolved".
 *
 *   enqueue (persisted) -> saving -> saved
 *                              \-> pending (auto-retry with backoff, alarm-driven)
 *                              \-> failed  (needs you: shown with a Retry button)
 *
 * The queue lives in chrome.storage, so a killed service worker never loses
 * an Accepted solution: the next worker start / alarm tick picks it up.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const KEY = () => LGS.CONST.STORAGE_KEYS.SAVE_QUEUE;
  const lock = LGS.formatter.createMutex();
  const STALE_SAVING_MS = 120000;

  const load = () => LGS.storage.getKey(KEY(), []);
  const persist = (items) => LGS.storage.setKey(KEY(), items);

  function alarms(on) {
    try {
      if (!global.chrome || !chrome.alarms) return;
      if (on) chrome.alarms.create(LGS.CONST.SAVE_ALARM, { periodInMinutes: 0.5 });
      else chrome.alarms.clear(LGS.CONST.SAVE_ALARM);
    } catch (e) { /* ignore */ }
  }

  async function setGh(item, gh, error) {
    await LGS.analytics.store.setEventGh(item.id, gh === 'saving' ? 'pending' : gh);
    await LGS.analytics.store.setLive({ gh, ghError: error || null }, item.id);
  }

  /** Adds a verified-Accepted model to the queue (idempotent per submission id). */
  async function enqueue(model) {
    const id = String(model.submissionId || LGS.formatter.randomId());
    await lock(async () => {
      const items = await load();
      if (items.some((i) => i.id === id)) return;
      items.push({ id, model, state: 'pending', attempts: 0, nextAt: 0, createdAt: Date.now(), lastError: null, title: model.title, slug: model.slug, language: model.language });
      await persist(items);
    });
    await setGh({ id }, 'pending');
    alarms(true);
    return id;
  }

  async function attempt(item) {
    await lock(async () => {
      const items = await load();
      const it = items.find((i) => i.id === item.id);
      if (it) { it.state = 'saving'; it.savingSince = Date.now(); await persist(items); }
    });
    await setGh(item, 'saving');
    try {
      const record = await LGS.sync.currentSync.syncSubmissionModel(item.model, { source: 'auto' });
      await lock(async () => { await persist((await load()).filter((i) => i.id !== item.id)); });
      await setGh(item, 'saved');
      return { ok: true, record };
    } catch (err) {
      const c = LGS.errors.classify(err);
      const delays = LGS.CONST.SAVE_RETRY_DELAYS_MS;
      let outcome;
      await lock(async () => {
        const items = await load();
        const it = items.find((i) => i.id === item.id);
        if (!it) return;
        it.attempts++;
        it.lastError = err.message;
        const giveUp = err.code === 'SYNC_REFUSED' || (c.needsUser && !c.autoRetry) || it.attempts > delays.length;
        if (giveUp) { it.state = 'failed'; outcome = 'failed'; }
        else {
          it.state = 'pending';
          it.nextAt = Date.now() + Math.max(delays[it.attempts - 1], LGS.errors.waitMsFor(err));
          outcome = 'pending';
        }
        await persist(items);
      });
      LGS.logger.warn('GitHub save', outcome === 'failed' ? 'failed:' : 'will retry:', err.message);
      await setGh(item, outcome || 'failed', err.message);
      return { ok: false, error: err.message, outcome };
    }
  }

  /** One pass over every job that is due now. */
  async function runPass() {
    let done = 0; let failed = 0;
    const config = await LGS.github.auth.loadConfig();
    if (!config) return { skipped: 'not-configured' };
    for (;;) {
      const now = Date.now();
      const due = (await load()).filter((i) => (i.state === 'pending' && i.nextAt <= now) || (i.state === 'saving' && now - (i.savingSince || 0) > STALE_SAVING_MS))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!due) break;
      const r = await attempt(due);
      if (r.ok) done++; else failed++;
      if (!r.ok && failed > 5) break;
    }
    return { done, failed };
  }

  /**
   * Runs every due job. Safe to call from anywhere, any number of times: a call
   * made while a pass is running asks for ONE more pass, so a job enqueued at
   * the very moment a pass finishes can never be missed.
   */
  let rerun = false;
  let running = null;
  function processDue() {
    if (running) { rerun = true; return running; } // the caller waits for the pass that will pick up its work
    running = (async () => {
      let total = { done: 0, failed: 0 };
      try {
        do {
          rerun = false;
          const r = await runPass();
          if (r.skipped) return r;
          total = { done: total.done + r.done, failed: total.failed + r.failed };
        } while (rerun);
        return total;
      } finally {
        const left = (await load()).filter((i) => i.state !== 'failed');
        alarms(left.length > 0);
        running = null;
      }
    })();
    return running;
  }

  async function retry(id) {
    await lock(async () => {
      const items = await load();
      items.filter((i) => id === 'all' ? i.state === 'failed' : i.id === id).forEach((i) => { i.state = 'pending'; i.nextAt = 0; i.attempts = 0; });
      await persist(items);
    });
    alarms(true);
    return processDue();
  }

  async function list() {
    return (await load()).map(({ model, ...rest }) => rest);
  }

  const failedCount = async () => (await load()).filter((i) => i.state === 'failed').length;
  const pendingCount = async () => (await load()).filter((i) => i.state !== 'failed').length;

  LGS.sync = LGS.sync || {};
  LGS.sync.saveQueue = { enqueue, processDue, retry, list, failedCount, pendingCount };
})(typeof self !== 'undefined' ? self : window);
