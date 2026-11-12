/**
 * sync-manager.js  (src/background/)
 *
 * The service worker never calls leetcode.com itself. Authenticated
 * requests run inside a leetcode.com tab (content script), riding the
 * user's own session. This module finds - or opens - such a tab and relays
 * requests to it.
 *
 * Improvements over v1 (review items 13, 14):
 *  - each BRIDGE owns its own tab lease (no shared global openedTabId);
 *  - a newly opened tab is waited on for up to ~20s with backoff;
 *  - tabs that were already open before the extension (re)loaded get the
 *    content scripts injected programmatically instead of failing;
 *  - tabs we opened are remembered in storage so they are closed even if
 *    the worker restarted in between;
 *  - a lost tab (closed / discarded / navigated away) is transparently
 *    re-acquired once.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { MSG, STORAGE_KEYS } = LGS.CONST;
  const sleep = LGS.formatter.sleep;

  const queryTabs = (q) => new Promise((resolve) => chrome.tabs.query(q, (t) => resolve(t || [])));
  const createTab = (url, active) => new Promise((resolve) => chrome.tabs.create({ url, active: !!active }, resolve));
  const removeTab = (id) => new Promise((resolve) => chrome.tabs.remove(id, () => { void chrome.runtime.lastError; resolve(); }));

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  function waitForTabComplete(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); fn(); };
      const timer = setTimeout(() => finish(() => reject(LGS.errors.makeError('LEETCODE_NO_TAB', 'Timed out waiting for the LeetCode tab to load.'))), timeoutMs);
      function listener(id, info) { if (id === tabId && info.status === 'complete') finish(resolve); }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (tab) => { if (tab && tab.status === 'complete') finish(resolve); });
    });
  }

  async function pingTab(tabId) {
    try {
      const res = await sendMessageToTab(tabId, { type: MSG.LEETCODE_PING });
      return !!(res && res.ok);
    } catch (e) { return false; }
  }

  /** Inject the manifest's content scripts (used for pre-existing tabs). */
  async function injectContentScripts(tabId) {
    if (!chrome.scripting) return false;
    try {
      const groups = chrome.runtime.getManifest().content_scripts || [];
      for (const g of groups) {
        const target = { tabId };
        const args = { target, files: g.js };
        if (g.world === 'MAIN') args.world = 'MAIN';
        await chrome.scripting.executeScript(args);
      }
      return true;
    } catch (err) {
      LGS.logger.warn('Could not inject content scripts into tab', tabId, err.message);
      return false;
    }
  }

  /** Waits (bounded, exponential backoff) until the tab's content script answers. */
  async function waitForContentScript(tabId, { timeoutMs = 20000, allowInject = true } = {}) {
    const start = Date.now();
    let delay = 250;
    let injected = false;
    let tries = 0;
    while (Date.now() - start < timeoutMs) {
      if (await pingTab(tabId)) return true;
      tries++;
      if (allowInject && !injected && tries >= 3) {
        injected = true;
        await injectContentScripts(tabId);
      }
      await sleep(delay);
      delay = Math.min(2000, Math.round(delay * 1.5));
    }
    return false;
  }

  async function trackOpened(tabId) {
    const ids = await LGS.storage.getKey(STORAGE_KEYS.OPENED_TABS, []);
    if (!ids.includes(tabId)) ids.push(tabId);
    await LGS.storage.setKey(STORAGE_KEYS.OPENED_TABS, ids);
  }

  async function closeOpenedTabs() {
    const ids = await LGS.storage.getKey(STORAGE_KEYS.OPENED_TABS, []);
    for (const id of ids) await removeTab(id);
    await LGS.storage.setKey(STORAGE_KEYS.OPENED_TABS, []);
  }

  async function acquireTab(allowOpen = true) {
    const tabs = (await queryTabs({ url: '*://leetcode.com/*' })).filter((t) => !t.discarded);
    tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0));

    for (const tab of tabs) if (await pingTab(tab.id)) return tab.id;

    // Tabs exist but have no (live) content script, e.g. opened before the
    // extension was loaded/reloaded: inject and try again.
    for (const tab of tabs) {
      if (await injectContentScripts(tab.id) && await waitForContentScript(tab.id, { timeoutMs: 6000, allowInject: false })) return tab.id;
    }

    if (!allowOpen) throw LGS.errors.makeError('LEETCODE_NO_TAB', 'No LeetCode tab is open.');
    const tab = await createTab(`${LGS.CONST.LEETCODE_ORIGIN}/problemset/`, false);
    await trackOpened(tab.id);
    await waitForTabComplete(tab.id);
    if (!(await waitForContentScript(tab.id, { timeoutMs: 20000 }))) {
      throw LGS.errors.makeError('LEETCODE_NO_TAB', 'The LeetCode tab opened but did not become ready. Open leetcode.com manually, log in, and try again.');
    }
    return tab.id;
  }

  /** The LeetCode PROBLEM tab the user most plausibly means. */
  async function getCurrentProblemTab() {
    const tabs = (await queryTabs({ url: '*://leetcode.com/problems/*' })).filter((t) => !t.discarded);
    if (!tabs.length) return null;

    let focusedWindowId = null;
    try { focusedWindowId = await new Promise((r) => chrome.windows.getLastFocused((w) => r(w && w.id))); } catch (e) { /* optional */ }

    const score = (t) => (t.active && t.windowId === focusedWindowId ? 2e15 : 0) + (t.active ? 1e15 : 0) + (t.lastAccessed || 0);
    tabs.sort((a, b) => score(b) - score(a));
    const tab = tabs[0];
    const m = /\/problems\/([a-z0-9-]+)/i.exec(tab.url || '');
    if (!m) return null;

    let language = null;
    try {
      const info = await sendMessageToTab(tab.id, { type: MSG.LEETCODE_GET_CURRENT_STATE });
      language = info && info.data && info.data.language;
    } catch (e) { /* content script not ready - language is optional */ }
    return { tabId: tab.id, slug: m[1].toLowerCase(), language };
  }

  function isConnectionError(err) {
    return /receiving end|port closed|no tab|cannot access|context invalidated|message channel/i.test((err && err.message) || '');
  }

  function createBridge(name, { allowOpen = true } = {}) {
    let leaseTabId = null;

    async function request(kind, payload) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (leaseTabId == null) leaseTabId = await acquireTab(allowOpen);
        let response;
        try {
          response = await sendMessageToTab(leaseTabId, { type: MSG.LEETCODE_REQUEST, payload: Object.assign({ kind }, payload) });
        } catch (err) {
          lastErr = err;
          leaseTabId = null; // tab went away - acquire a fresh one
          if (isConnectionError(err) && attempt === 0) continue;
          throw LGS.errors.makeError('LEETCODE_BRIDGE_ERROR', `Lost contact with the LeetCode tab: ${err.message}`);
        }
        if (!response) {
          leaseTabId = null;
          lastErr = new Error('No response from LeetCode tab.');
          if (attempt === 0) continue;
          throw LGS.errors.makeError('LEETCODE_BRIDGE_ERROR', lastErr.message);
        }
        if (response.error) {
          throw LGS.errors.makeError(response.error.code || 'LEETCODE_BRIDGE_ERROR', response.error.message || 'LeetCode request failed.', {
            status: response.error.status, retryAfterMs: response.error.retryAfterMs
          });
        }
        return response.data;
      }
      throw lastErr;
    }

    return {
      name,
      listPage: (params) => request('listPage', { params }),
      listForSlug: (slug, options) => request('listForSlug', { slug, options }),
      getDetail: (submissionId) => request('detail', { submissionId }),
      getQuestionMeta: (slug) => request('questionMeta', { slug }),
      checkAuth: () => request('userStatus', {}),
      getSolvedStats: () => request('solvedStats', {}),
      listSolved: (options) => request('solvedList', { options }),
      resolveProblem: (slug, options) => request('resolveProblem', { slug, options }),
      probe: (options) => request('probe', { options }),
      release() { leaseTabId = null; }
    };
  }

  LGS.syncManager = {
    createBridge, defaultBridge: createBridge('default'),
    getCurrentProblemTab, closeOpenedTabs, pingTab, injectContentScripts, acquireTab
  };
})(typeof self !== 'undefined' ? self : window);
