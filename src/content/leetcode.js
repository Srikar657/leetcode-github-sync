/**
 * leetcode.js  (src/content/)
 *
 * Entry point injected into leetcode.com pages. It:
 *   1. answers requests from the background (the ONLY place authenticated
 *      LeetCode requests are made, so they ride the user's own session),
 *   2. starts the PASSIVE submission watcher (it only reads; it never submits).
 *
 * It can be injected a second time (the background re-injects into tabs
 * that were open before the extension was loaded), so everything with side
 * effects is behind a once-only guard.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  if (global.__LGS_CONTENT_INIT__) return;
  global.__LGS_CONTENT_INIT__ = true;

  const { MSG } = LGS.CONST;
  const subs = () => LGS.leetcode.submissions;

  async function handleRequest(payload) {
    const p = payload || {};
    switch (p.kind) {
      case 'listPage': return subs().listPage(p.params || {});
      case 'listForSlug': return subs().listForSlug(p.slug, p.options || {});
      case 'detail': return subs().getDetail(p.submissionId);
      case 'questionMeta': return subs().getQuestionMeta(p.slug);
      case 'userStatus': return subs().getUserStatus();
      case 'solvedStats': return subs().getSolvedStats();
      case 'solvedList': return subs().listSolved(p.options || {});
      case 'resolveProblem': return subs().resolveProblem(p.slug, p.options || {});
      case 'probe': return subs().probe(p.options || {});
      default:
        throw LGS.errors.makeError('LEETCODE_BRIDGE_UNKNOWN_KIND', `Unknown bridge request kind: ${p.kind}`);
    }
  }

  function currentPageInfo() {
    const parser = LGS.leetcode.parser;
    return {
      slug: parser.getSlugFromUrl(),
      url: location.href,
      language: parser.getSelectedLanguageLabel(),
      title: parser.getTitleAndNumber().title
    };
  }

  function respond(sendResponse, promise) {
    promise
      .then((data) => sendResponse({ data }))
      .catch((err) => sendResponse({ error: { message: err.message, code: err.code, status: err.status, retryAfterMs: err.retryAfterMs } }));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;
    switch (message.type) {
      case MSG.LEETCODE_PING:
        sendResponse({ ok: true, version: LGS.CONST.VERSION });
        return false;
      case MSG.LEETCODE_REQUEST:
        respond(sendResponse, handleRequest(message.payload));
        return true;
      case MSG.LEETCODE_GET_CURRENT_STATE:
        sendResponse({ data: currentPageInfo() });
        return false;
      default:
        return false;
    }
  });

  LGS.content = LGS.content || {};
  LGS.storage.getSettings().then((s) => LGS.logger.setDebugEnabled(!!s.debugLogging)).catch(() => {});
  LGS.content.widget.init().catch((e) => LGS.logger.warn('Panel failed to start:', e.message));

  // Passive watch: one cheap read-only look at the current problem every few seconds.
  setInterval(() => { LGS.content.observer.tick(); }, 4000);
  LGS.content.observer.tick();

  try { chrome.runtime.sendMessage({ type: MSG.CONTENT_READY }); } catch (e) { /* worker asleep - fine */ }
})(typeof self !== 'undefined' ? self : window);
