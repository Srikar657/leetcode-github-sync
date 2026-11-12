/**
 * graphql.js  (src/leetcode/)
 *
 * HTTP + GraphQL client for leetcode.com. Only ever loaded in the LeetCode
 * content-script context, so every fetch() rides the user's own logged-in
 * browser session. We never read cookies via chrome.cookies, never ask for
 * a session token and never forward anything from here to GitHub.
 *
 * Authentication is NOT guessed from document.cookie (LEETCODE_SESSION is
 * HttpOnly and invisible there - review item 15). Instead we just make the
 * request and translate what LeetCode answers: 401/403, login redirects,
 * "not authenticated" GraphQL errors, Cloudflare challenges.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { LEETCODE_ORIGIN, LEETCODE_REQUEST_TIMEOUT_MS } = LGS.CONST;
  const E = () => LGS.errors;

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  const VALIDATION_RE = /cannot query field|unknown argument|unknown type|variable ["'$]|of type .* used in position|is not defined by type|field ["'].+["'] (?:of type|must have|argument)|validation|syntax error|expected type|must not be null|bad request/i;
  const AUTH_RE = /not authenticated|sign in|log in|login required|please login|unauthori[sz]ed|authentication credentials|permission denied|must be logged/i;

  function parseRetryAfter(response) {
    const h = response.headers && response.headers.get && response.headers.get('retry-after');
    const n = h ? Number(h) : NaN;
    return Number.isFinite(n) ? n * 1000 : 30000;
  }

  /**
   * fetch() with timeout + uniform LeetCode error translation. Returns the
   * parsed JSON body. `expectJson:false` returns raw text.
   */
  async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = LEETCODE_REQUEST_TIMEOUT_MS } = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'include',
        headers: Object.assign({ 'x-csrftoken': getCsrfToken() }, headers),
        body,
        signal: controller ? controller.signal : undefined
      });
    } catch (netErr) {
      if (timer) clearTimeout(timer);
      if (netErr && netErr.name === 'AbortError') {
        throw E().makeError('LEETCODE_TIMEOUT', 'LeetCode did not answer in time.');
      }
      throw E().makeError('LEETCODE_NETWORK_ERROR', 'Network error while contacting LeetCode.', { cause: netErr });
    }
    if (timer) clearTimeout(timer);

    if (response.status === 429) {
      throw E().makeError('LEETCODE_RATE_LIMITED', 'LeetCode is rate limiting requests.', { status: 429, retryAfterMs: parseRetryAfter(response) });
    }
    if (response.status === 401) {
      throw E().makeError('LEETCODE_NOT_AUTHENTICATED', 'You are not logged into LeetCode.', { status: 401 });
    }
    if (response.status === 403) {
      let snippet = '';
      try { snippet = (await response.text()).slice(0, 600); } catch (e) { /* ignore */ }
      if (/just a moment|cf-chl|cloudflare|attention required|challenge|captcha|enable javascript/i.test(snippet)) {
        throw E().makeError('LEETCODE_BLOCKED', 'LeetCode showed a Cloudflare check. Open leetcode.com in a tab, complete the check, then Resume.', { status: 403 });
      }
      throw E().makeError('LEETCODE_NOT_AUTHENTICATED', 'LeetCode denied access - are you logged in?', { status: 403 });
    }
    if (response.status >= 500) {
      throw E().makeError('LEETCODE_GRAPHQL_ERROR', `LeetCode server error (HTTP ${response.status}).`, { status: response.status });
    }
    if (!response.ok) {
      throw E().makeError('LEETCODE_HTTP_ERROR', `LeetCode request failed (HTTP ${response.status}).`, { status: response.status });
    }
    if (response.redirected && /\/accounts\/login|\/login/.test(response.url || '')) {
      throw E().makeError('LEETCODE_NOT_AUTHENTICATED', 'LeetCode redirected to the login page.');
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      if (/<html|<!doctype/i.test(text.slice(0, 200)) && /login|sign in/i.test(text.slice(0, 4000))) {
        throw E().makeError('LEETCODE_NOT_AUTHENTICATED', 'LeetCode returned a login page instead of data.');
      }
      throw E().makeError('LEETCODE_BAD_RESPONSE', 'LeetCode returned a response that is not JSON.');
    }
  }

  /** POST a GraphQL operation. Returns json.data. */
  async function query(queryString, variables, operationName) {
    const json = await fetchJson(`${LEETCODE_ORIGIN}/graphql/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryString, variables: variables || {}, operationName })
    });

    if (json && Array.isArray(json.errors) && json.errors.length) {
      const message = json.errors.map((e) => e && e.message).filter(Boolean).join('; ') || 'GraphQL error';
      if (AUTH_RE.test(message)) {
        throw E().makeError('LEETCODE_NOT_AUTHENTICATED', 'You are not logged into LeetCode.', { graphqlErrors: json.errors });
      }
      // Partial data alongside errors: usable.
      if (json.data && Object.values(json.data).some((v) => v != null)) return json.data;
      throw E().makeError('LEETCODE_GRAPHQL_ERROR', message, {
        graphqlErrors: json.errors,
        isValidation: VALIDATION_RE.test(message)
      });
    }
    return json ? json.data : null;
  }

  /** GET a LeetCode REST path (e.g. "/api/submissions/?offset=0"). */
  function restGet(path) {
    return fetchJson(`${LEETCODE_ORIGIN}${path}`, { method: 'GET', headers: { Accept: 'application/json' } });
  }

  LGS.leetcode = LGS.leetcode || {};
  LGS.leetcode.graphql = { query, restGet, fetchJson, getCsrfToken, VALIDATION_RE };
})(typeof self !== 'undefined' ? self : window);
