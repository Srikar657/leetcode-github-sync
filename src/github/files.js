/**
 * files.js  (src/github/)
 *
 * GitHub Contents API wrapper. Creating a file never sends a `sha`;
 * updating always sends the CURRENT sha. UTF-8 safe base64.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { api } = LGS.github;

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(String(b64).replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

  /** { exists, sha, content } - a 404 means "does not exist", not an error. */
  async function getFile(token, owner, repo, path, ref) {
    try {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const data = await api.request(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
      if (Array.isArray(data)) return { exists: false };
      return { exists: true, sha: data.sha, content: data.content ? base64ToUtf8(data.content) : '', path: data.path };
    } catch (err) {
      if (err.status === 404) return { exists: false };
      throw err;
    }
  }

  async function putFile(token, owner, repo, { path, content, message, branch, sha }) {
    const body = { message, content: utf8ToBase64(content), branch };
    if (sha) body.sha = sha;
    const result = await api.request(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, { method: 'PUT', body });
    return {
      path: result.content.path,
      sha: result.content.sha,
      htmlUrl: result.content.html_url,
      action: sha ? 'updated' : 'created'
    };
  }

  async function deleteFile(token, owner, repo, { path, message, branch, sha }) {
    return api.request(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, { method: 'DELETE', body: { message, branch, sha } });
  }

  /** Every file in the branch in ONE call: { map: path -> blobSha, truncated }. */
  async function getBranchTree(token, owner, repo, branch) {
    let branchInfo;
    try {
      branchInfo = await api.request(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err.status === 404) {
        throw LGS.errors.makeError('GITHUB_API_ERROR',
          `Branch "${branch}" was not found. If the repository is brand new, add a README on GitHub first so the branch exists.`,
          { status: 404 });
      }
      throw err;
    }
    const treeSha = branchInfo && branchInfo.commit && branchInfo.commit.commit && branchInfo.commit.commit.tree && branchInfo.commit.commit.tree.sha;
    if (!treeSha) throw LGS.errors.makeError('GITHUB_API_ERROR', 'Could not read the branch tree from GitHub.', { status: 500 });

    const tree = await api.request(token, `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
    const map = new Map();
    ((tree && tree.tree) || []).forEach((t) => { if (t.type === 'blob') map.set(t.path, t.sha); });
    return { map, truncated: !!(tree && tree.truncated) };
  }

  LGS.github = LGS.github || {};
  LGS.github.files = { getFile, putFile, deleteFile, getBranchTree, utf8ToBase64, base64ToUtf8, encodePath };
})(typeof self !== 'undefined' ? self : window);
