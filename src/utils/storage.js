/**
 * storage.js
 *
 * Promise wrapper around chrome.storage.local plus typed helpers for
 * every value this extension persists. Centralizing this avoids scattered
 * raw chrome.storage calls and key strings.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { STORAGE_KEYS, DEFAULT_SETTINGS, SETTING_LIMITS, SETTING_ENUMS } = LGS.CONST;

  function get(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result || {});
      });
    });
  }

  function set(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function remove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  async function getKey(key, fallback) {
    const result = await get(key);
    return result[key] === undefined ? fallback : result[key];
  }

  function setKey(key, value) { return set({ [key]: value }); }

  /** Clamp numbers and validate enums so a bad value can never reach the sync code. */
  function sanitizeSettings(input) {
    const out = Object.assign({}, DEFAULT_SETTINGS, input || {});
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const def = DEFAULT_SETTINGS[key];
      if (typeof def === 'boolean') out[key] = !!out[key];
      else if (typeof def === 'number') {
        const n = Number(out[key]);
        const lim = SETTING_LIMITS[key] || { min: 0, max: Number.MAX_SAFE_INTEGER };
        out[key] = Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, Math.round(n))) : def;
      } else if (SETTING_ENUMS[key] && !SETTING_ENUMS[key].includes(out[key])) {
        out[key] = def;
      }
    }
    // drop unknown keys
    for (const key of Object.keys(out)) if (!(key in DEFAULT_SETTINGS)) delete out[key];
    return out;
  }

  async function getGithubConfig() { return getKey(STORAGE_KEYS.GITHUB_CONFIG, null); }
  async function setGithubConfig(config) { await setKey(STORAGE_KEYS.GITHUB_CONFIG, config); }

  async function getSettings() {
    return sanitizeSettings(await getKey(STORAGE_KEYS.SETTINGS, {}));
  }

  /** Merges a (possibly partial) update into the stored settings. */
  async function setSettings(patch) {
    const current = await getKey(STORAGE_KEYS.SETTINGS, {});
    const merged = sanitizeSettings(Object.assign({}, current, patch || {}));
    await setKey(STORAGE_KEYS.SETTINGS, merged);
    return merged;
  }

  async function getSyncHistory() { return getKey(STORAGE_KEYS.SYNC_HISTORY, []); }

  const historyLock = LGS.formatter.createMutex();
  function addSyncHistoryEntry(entry, max = 500) {
    return historyLock(async () => {
      const history = await getSyncHistory();
      history.unshift(entry);
      if (history.length > max) history.length = max;
      await setKey(STORAGE_KEYS.SYNC_HISTORY, history);
      return history;
    });
  }

  async function getHistoricalProgress() { return getKey(STORAGE_KEYS.HISTORICAL_PROGRESS, null); }
  async function setHistoricalProgress(p) { await setKey(STORAGE_KEYS.HISTORICAL_PROGRESS, p); }

  async function getSyncedSubmissionIds() {
    return new Set(await getKey(STORAGE_KEYS.SYNCED_SUBMISSION_IDS, []));
  }

  const idsLock = LGS.formatter.createMutex();
  function addSyncedSubmissionId(id) {
    return idsLock(async () => {
      const ids = await getSyncedSubmissionIds();
      ids.add(String(id));
      // keep the newest 5000 only
      const arr = Array.from(ids);
      await setKey(STORAGE_KEYS.SYNCED_SUBMISSION_IDS, arr.length > 5000 ? arr.slice(-5000) : arr);
    });
  }

  async function getRetryList() { return getKey(STORAGE_KEYS.RETRY_LIST, []); }
  async function setRetryList(list) { await setKey(STORAGE_KEYS.RETRY_LIST, list); }

  LGS.storage = {
    get, set, remove, getKey, setKey, sanitizeSettings,
    getGithubConfig, setGithubConfig,
    getSettings, setSettings,
    getSyncHistory, addSyncHistoryEntry,
    getHistoricalProgress, setHistoricalProgress,
    getSyncedSubmissionIds, addSyncedSubmissionId,
    getRetryList, setRetryList
  };
})(typeof self !== 'undefined' ? self : window);
