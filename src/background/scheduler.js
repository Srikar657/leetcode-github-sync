/**
 * scheduler.js  (src/background/)
 *
 * Keeps long jobs alive and resumable in a Manifest V3 service worker
 * (review item 12). Chrome may stop the worker at any time, so:
 *
 *  - a repeating alarm ("tick", every 30s while a job is active) wakes the
 *    worker after a kill and lets the job RESUME FROM ITS CHECKPOINT;
 *  - a one-shot "wake" alarm resumes a job parked on a long rate limit;
 *  - while a job loop is running, a cheap extension-API call every 20s
 *    resets the worker's idle timer.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { JOB_ALARM, WAKE_ALARM } = LGS.CONST;
  let keepAliveTimer = null;

  const hasAlarms = () => !!(global.chrome && chrome.alarms);

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (e) { /* ignore */ }
    }, 20000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }

  function ensureTick(on) {
    if (!hasAlarms()) return;
    if (on) chrome.alarms.create(JOB_ALARM, { periodInMinutes: 0.5 });
    else chrome.alarms.clear(JOB_ALARM);
  }

  function wakeAt(timestampMs) {
    if (hasAlarms()) chrome.alarms.create(WAKE_ALARM, { when: Math.max(Date.now() + 1000, timestampMs) });
  }

  function clearWake() { if (hasAlarms()) chrome.alarms.clear(WAKE_ALARM); }

  LGS.scheduler = { startKeepAlive, stopKeepAlive, ensureTick, wakeAt, clearWake };
})(typeof self !== 'undefined' ? self : window);
