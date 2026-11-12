/**
 * retry.js  (src/sync/)
 *
 * Exponential backoff for transient failures plus a persisted retry list
 * for items that failed for good. Error classification lives in
 * utils/errors.js so everything agrees on what is retryable (item 24).
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function isRetryable(err) {
    return !!err && LGS.errors.classify(err).autoRetry;
  }

  /**
   * Runs `fn` with backoff on retryable errors. A rate-limit that asks for
   * a wait longer than MAX_INLINE_WAIT_MS is NOT slept in-process (the MV3
   * worker could die); the error is thrown with `err.longWait = true` so the
   * job can park itself and let an alarm wake it up.
   */
  async function withRetry(fn, opts = {}) {
    const C = LGS.CONST;
    const maxAttempts = opts.maxAttempts || C.MAX_RETRY_ATTEMPTS;
    const baseDelayMs = opts.baseDelayMs != null ? opts.baseDelayMs : C.RETRY_BASE_DELAY_MS;
    let attempt = 0;
    let lastErr;
    while (attempt < maxAttempts) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        attempt++;
        if (typeof opts.onAttemptFailed === 'function') opts.onAttemptFailed(err, attempt);
        if (!isRetryable(err) || attempt >= maxAttempts) throw err;

        let delay = baseDelayMs * Math.pow(2, attempt - 1);
        const asked = LGS.errors.waitMsFor(err);
        if (asked > C.MAX_INLINE_WAIT_MS) {
          err.longWait = true;
          err.waitMs = asked;
          throw err;
        }
        delay = Math.max(delay, asked);
        await LGS.formatter.sleep(delay);
      }
    }
    throw lastErr;
  }

  async function addToRetryList(item) {
    const list = await LGS.storage.getRetryList();
    const entry = Object.assign({ id: LGS.formatter.randomId() }, item);
    const key = entry.candidate && entry.candidate.key;
    const filtered = key ? list.filter((i) => !(i.candidate && i.candidate.key === key)) : list;
    filtered.push(entry);
    await LGS.storage.setRetryList(filtered.slice(-1000));
    return entry;
  }

  async function removeFromRetryList(predicate) {
    const list = await LGS.storage.getRetryList();
    const removed = list.filter((i) => predicate(i));
    await LGS.storage.setRetryList(list.filter((i) => !predicate(i)));
    return removed;
  }

  async function clearRetryList() { await LGS.storage.setRetryList([]); }

  LGS.sync = LGS.sync || {};
  LGS.sync.retry = { withRetry, isRetryable, addToRetryList, removeFromRetryList, clearRetryList };
})(typeof self !== 'undefined' ? self : window);
