/**
 * repository.js  (src/github/)
 *
 * Repository/branch-level checks and the "Test GitHub Connection" flow.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { api } = LGS.github;

  function getRepository(token, owner, repo) { return api.request(token, `/repos/${owner}/${repo}`); }
  function getBranch(token, owner, repo, branch) { return api.request(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`); }
  function getRateLimit(token) { return api.request(token, '/rate_limit'); }

  /** Never throws for expected failures - callers render ok/message directly. */
  async function testConnection({ owner, repo, branch, token }) {
    try {
      const repoInfo = await getRepository(token, owner, repo);
      const canWrite = !!(repoInfo && repoInfo.permissions && (repoInfo.permissions.push || repoInfo.permissions.admin));

      let branchInfo;
      try {
        branchInfo = await getBranch(token, owner, repo, branch);
      } catch (branchErr) {
        const hint = branchErr.status === 404
          ? ' If the repository is empty, create a README on GitHub first so the branch exists.'
          : '';
        return { ok: false, message: `Repository found, but branch "${branch}" could not be verified: ${branchErr.message}${hint}` };
      }

      return {
        ok: true,
        message: 'GitHub connection successful',
        repository: `${owner}/${repo}`,
        branch: branchInfo.name,
        isPrivate: !!(repoInfo && repoInfo.private),
        canWrite,
        warning: canWrite ? null : 'This token does not appear to have write access to the repository. Uploads will fail until the token\'s "Contents" permission is set to Read and write.'
      };
    } catch (err) {
      return { ok: false, message: err.message || 'GitHub connection failed.', code: err.code };
    }
  }

  LGS.github = LGS.github || {};
  LGS.github.repository = { getRepository, getBranch, getRateLimit, testConnection };
})(typeof self !== 'undefined' ? self : window);
