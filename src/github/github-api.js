/**
 * github-api.js  (src/github/)
 *
 * Low-level fetch wrapper around the GitHub REST API. Every GitHub call
 * goes through request() so auth headers, error translation and rate-limit
 * detection (primary AND secondary) are handled in exactly one place.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { GITHUB_API_BASE } = LGS.CONST;

  class GitHubRateLimitError extends Error {
    constructor(resetAt, secondary) {
      super(secondary ? 'GitHub secondary rate limit reached.' : 'GitHub API rate limit reached.');
      this.code = 'GITHUB_RATE_LIMITED';
      this.resetAt = resetAt;
      this.secondary = !!secondary;
    }
  }

  class GitHubApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.code = 'GITHUB_API_ERROR';
      this.status = status;
      this.body = body;
    }
  }

  function friendlyMessageForStatus(status, body) {
    const detail = body && body.message ? ` (${String(body.message).slice(0, 160)})` : '';
    switch (status) {
      case 401: return 'GitHub rejected the token. Check that it is correct and has not expired.';
      case 403: return 'GitHub denied access. Check the token\'s repository permissions (Contents: Read and write).';
      case 404: return 'GitHub repository, branch or file could not be found. Check the owner, repository name, branch, and that the token can access it.';
      case 409: return 'GitHub reported a conflict (the repository changed while writing).' + detail;
      case 422: return 'GitHub rejected the request as invalid.' + detail;
      case 500: case 502: case 503: case 504: return 'GitHub is temporarily unavailable.';
      default: return `GitHub API request failed (HTTP ${status}).` + detail;
    }
  }

  async function request(token, path, { method = 'GET', body = null, headers = {} } = {}) {
    if (!token) {
      throw LGS.errors.makeError('GITHUB_NOT_CONFIGURED', 'No GitHub token configured.');
    }

    let response;
    try {
      response = await fetch(`${GITHUB_API_BASE}${path}`, {
        method,
        headers: Object.assign({
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        }, headers),
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (networkErr) {
      throw LGS.errors.makeError('GITHUB_NETWORK_ERROR', 'Network error while contacting GitHub.', { cause: networkErr });
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');

    if (response.status === 204) return null;

    let json = null;
    const text = await response.text();
    if (text) {
      try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    }

    if (response.status === 429 || response.status === 403) {
      const message = json && json.message ? String(json.message) : '';
      const isLimited = response.status === 429 || remaining === '0' || !!retryAfter || /rate limit|abuse/i.test(message);
      if (isLimited) {
        let resetAt = Date.now() + 60000;
        if (retryAfter && Number.isFinite(Number(retryAfter))) resetAt = Date.now() + Number(retryAfter) * 1000;
        else if (resetHeader) resetAt = Number(resetHeader) * 1000;
        throw new GitHubRateLimitError(resetAt, remaining !== '0');
      }
    }

    if (!response.ok) {
      throw new GitHubApiError(friendlyMessageForStatus(response.status, json), response.status, json);
    }
    return json;
  }

  LGS.github = LGS.github || {};
  LGS.github.api = { request, GitHubRateLimitError, GitHubApiError, friendlyMessageForStatus };
})(typeof self !== 'undefined' ? self : window);
