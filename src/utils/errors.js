/**
 * errors.js
 *
 * Classifies any error thrown inside the extension into a category so
 * the retry logic, the dashboard and the logs can all speak the same
 * language (review item 24):
 *
 *   auth | blocked | rate_limit | network | server | missing_code | schema |
 *   github_conflict | permission | config | invalid_metadata | not_accepted | unknown
 *
 * `autoRetry`  -> worth retrying automatically / by "Retry recoverable".
 * `needsUser`  -> the user must do something (log in, fix a token...).
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  const LABELS = {
    auth: 'LeetCode login',
    blocked: 'LeetCode blocked request',
    rate_limit: 'Rate limit',
    network: 'Network',
    server: 'Server error',
    missing_code: 'Missing code',
    schema: 'LeetCode API changed',
    github_conflict: 'GitHub conflict',
    permission: 'GitHub permission',
    config: 'Configuration',
    invalid_metadata: 'Invalid metadata',
    not_accepted: 'Not accepted',
    unknown: 'Unknown'
  };

  function make(category, autoRetry, needsUser) {
    return { category, label: LABELS[category], autoRetry: !!autoRetry, needsUser: !!needsUser };
  }

  function classify(err) {
    if (!err) return make('unknown', false, false);
    const code = err.code;
    const status = err.status;

    switch (code) {
      case 'LEETCODE_NOT_AUTHENTICATED': return make('auth', false, true);
      case 'LEETCODE_BLOCKED': return make('blocked', false, true);
      case 'LEETCODE_RATE_LIMITED':
      case 'GITHUB_RATE_LIMITED': return make('rate_limit', true, false);
      case 'LEETCODE_NETWORK_ERROR':
      case 'GITHUB_NETWORK_ERROR':
      case 'LEETCODE_TIMEOUT':
      case 'LEETCODE_POLL_TIMEOUT': return make('network', true, false);
      case 'LEETCODE_MISSING_CODE': return make('missing_code', false, false);
      case 'LEETCODE_SCHEMA_ERROR':
      case 'LEETCODE_BAD_RESPONSE':
      case 'PAGINATION_STALLED': return make('schema', false, true);
      case 'GITHUB_NOT_CONFIGURED':
      case 'GITHUB_CONFIG_INVALID': return make('config', false, true);
      case 'LEETCODE_NO_TAB':
      case 'LEETCODE_NO_ACTIVE_TAB':
      case 'LEETCODE_BRIDGE_ERROR': return make('network', true, false);
      case 'SYNC_REFUSED':
        return err.reason === 'metadata' ? make('invalid_metadata', false, false) : make('not_accepted', false, false);
      case 'LEETCODE_GRAPHQL_ERROR':
      case 'LEETCODE_CHECK_ERROR':
      case 'LEETCODE_HTTP_ERROR':
        return status >= 500 ? make('server', true, false) : make('schema', false, true);
      case 'GITHUB_API_ERROR':
        if (status === 409) return make('github_conflict', true, false);
        if (status === 401 || status === 403) return make('permission', false, true);
        if (status === 404) return make('config', false, true);
        if (status === 422) return make('invalid_metadata', false, false);
        if (status >= 500) return make('server', true, false);
        return make('unknown', false, false);
      default:
        return make('unknown', false, false);
    }
  }

  /** Waiting time (ms) an error asks for, or 0. */
  function waitMsFor(err) {
    if (!err) return 0;
    if (err.code === 'GITHUB_RATE_LIMITED' && err.resetAt) return Math.max(0, err.resetAt - Date.now());
    if (err.code === 'LEETCODE_RATE_LIMITED') return err.retryAfterMs || 30000;
    return 0;
  }

  function makeError(code, message, extra) {
    const err = new Error(message || code);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
  }

  LGS.errors = { classify, waitMsFor, makeError, LABELS };
})(typeof self !== 'undefined' ? self : window);
