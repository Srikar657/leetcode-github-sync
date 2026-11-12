/**
 * service-worker.js  (src/background/)
 *
 * MV3 background entry point. Uses classic importScripts() (no ES modules)
 * so the same plain-script files are shared with content scripts and pages.
 * All listeners are registered synchronously at top level, as MV3 requires.
 */
importScripts(
  '../utils/constants.js',
  '../utils/formatter.js',
  '../utils/errors.js',
  '../utils/logger.js',
  '../utils/storage.js',
  '../utils/languages.js',

  '../leetcode/status.js',
  '../leetcode/metadata.js',

  '../analytics/stats.js',
  '../analytics/store.js',

  '../github/auth.js',
  '../github/github-api.js',
  '../github/files.js',
  '../github/repository.js',
  '../github/session.js',
  '../github/readme.js',

  '../sync/queue.js',
  '../sync/retry.js',
  '../sync/duplicate-checker.js',
  '../sync/index-store.js',
  '../sync/publisher.js',
  '../sync/decisions.js',

  'sync-manager.js',
  'scheduler.js',
  '../analytics/stats-sync.js',

  '../sync/current-sync.js',
  '../sync/save-queue.js',
  '../sync/historical-sync.js',
  '../sync/repo-tools.js',
  '../sync/diagnostics.js',

  'message-handler.js'
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  LGS.messageHandler.dispatch(message, sender, sendResponse));

// Resume checkpointed jobs after the worker was killed, or a rate-limit wait ended.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LGS.CONST.JOB_ALARM || alarm.name === LGS.CONST.WAKE_ALARM) {
    LGS.sync.historicalSync.tick().catch((e) => LGS.logger.error('tick failed:', e.message));
  }
  if (alarm.name === LGS.CONST.SAVE_ALARM) {
    LGS.sync.saveQueue.processDue().catch((e) => LGS.logger.error('save queue tick failed:', e.message));
  }
});

async function applySettings() {
  const settings = await LGS.storage.getSettings();
  LGS.logger.setDebugEnabled(settings.debugLogging);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  LGS.logger.info('LeetCode GitHub Sync installed/updated:', details.reason);
  await applySettings();
  try {
    // v1 -> v2 upgrade: drop obsolete keys, reset incompatible job state, build the index from history.
    await LGS.storage.remove([LGS.CONST.STORAGE_KEYS.LEGACY_SYNC_QUEUE, LGS.CONST.STORAGE_KEYS.LEGACY_DEBUG_LOG]);
    const progress = await LGS.storage.getHistoricalProgress();
    if (progress && progress.queueBuilt === undefined) await LGS.sync.historicalSync.resetAll();
    await LGS.sync.repoTools.migrateFromHistory();
  } catch (e) { LGS.logger.warn('Upgrade step failed:', e.message); }
});

chrome.runtime.onStartup.addListener(() => { applySettings(); });

// Every time the worker (re)starts: pick an interrupted job back up.
applySettings();
LGS.sync.historicalSync.tick().catch((e) => LGS.logger.warn('startup tick failed:', e.message));
// Never lose an Accepted solution: resume any queued GitHub saves after a worker restart.
LGS.sync.saveQueue.processDue().catch((e) => LGS.logger.warn('startup save-queue run failed:', e.message));
