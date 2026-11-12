/**
 * auth.js  (src/github/)
 *
 * Storage and validation of the GitHub configuration (owner, repo, branch,
 * fine-grained personal access token). The token lives only in
 * chrome.storage.local, is never logged, never sent to LeetCode and never
 * echoed back to any UI. This is the only module that reads it for use, so
 * swapping in OAuth later only touches auth.js + github-api.js.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function validateConfigShape(config) {
    const errors = [];
    if (!config || typeof config !== 'object') return ['Missing GitHub configuration.'];
    if (!config.owner || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(config.owner)) errors.push('Owner must be a valid GitHub username or organization.');
    if (!config.repo || !/^[a-zA-Z0-9._-]{1,100}$/.test(config.repo) || config.repo === '.' || config.repo === '..') errors.push('Repository name is required and must be a valid GitHub repo name.');
    if (!config.branch || !/^[^\s~^:?*\[\\]+$/.test(config.branch.trim()) || /\.\./.test(config.branch)) errors.push('Branch name is invalid.');
    if (!config.token || config.token.trim().length < 10) errors.push('A GitHub personal access token is required.');
    return errors;
  }

  /** Saves the config. A blank token keeps the previously saved one. */
  async function saveConfig(input) {
    const existing = await LGS.storage.getGithubConfig();
    const candidate = Object.assign({}, input);
    if ((!candidate.token || !candidate.token.trim()) && existing && existing.token) candidate.token = existing.token;

    const errors = validateConfigShape(candidate);
    if (errors.length) {
      throw LGS.errors.makeError('GITHUB_CONFIG_INVALID', errors.join(' '), { details: errors });
    }
    const clean = {
      owner: candidate.owner.trim(),
      repo: candidate.repo.trim(),
      branch: candidate.branch.trim(),
      token: candidate.token.trim()
    };
    await LGS.storage.setGithubConfig(clean);
    LGS.logger.info('GitHub config saved for repository', `${clean.owner}/${clean.repo}@${clean.branch}`);
    return clean;
  }

  async function loadConfig() { return LGS.storage.getGithubConfig(); }

  /** "Disconnect": removes the token and repository settings from this browser. */
  async function clearConfig() {
    await LGS.storage.remove(LGS.CONST.STORAGE_KEYS.GITHUB_CONFIG);
  }

  /** What UIs are allowed to see - never the token itself. */
  function publicView(config) {
    return config ? { owner: config.owner, repo: config.repo, branch: config.branch, hasToken: !!config.token } : null;
  }

  LGS.github = LGS.github || {};
  LGS.github.auth = { validateConfigShape, saveConfig, loadConfig, clearConfig, publicView };
})(typeof self !== 'undefined' ? self : window);
