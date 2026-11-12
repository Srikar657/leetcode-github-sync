/**
 * session.js  (src/github/)
 *
 * A GitHubSession is one logical batch of work against one repository.
 * It solves three problems at once:
 *
 *  - FEWER API CALLS (review items 7, 8): the whole branch tree is fetched
 *    ONCE; "does this file exist and with which sha?" becomes a map lookup
 *    instead of a GET per file. A file whose content already matches
 *    GitHub (compared by git blob SHA) is never rewritten - so re-running
 *    a sync on an up-to-date repo performs zero writes.
 *
 *  - CONFLICT SAFETY (review item 20): on 409 / stale-sha 422 the LATEST sha
 *    is re-fetched before retrying; the stale sha is never resent.
 *
 *  - POLITE PACING: GitHub asks clients to leave >= 1s between content
 *    writes; the session sleeps `writeDelayMs` after each successful write.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { gitBlobSha, sleep } = LGS.formatter;

  class GithubSession {
    constructor(config, { writeDelayMs = 0 } = {}) {
      this.config = config;
      this.writeDelayMs = writeDelayMs;
      this.treeMap = null;
      this.truncated = false;
      this.shaCache = new Map();
      this.writes = 0;
    }

    get token() { return this.config.token; }

    async loadTree() {
      const { owner, repo, branch } = this.config;
      const { map, truncated } = await LGS.sync.retry.withRetry(
        () => LGS.github.files.getBranchTree(this.token, owner, repo, branch)
      );
      this.treeMap = map;
      this.truncated = truncated;
      return { files: map.size, truncated };
    }

    hasTree() { return !!this.treeMap && !this.truncated; }

    /** All blob paths currently known (only meaningful after loadTree). */
    paths() { return this.treeMap ? Array.from(this.treeMap.keys()) : []; }

    async getSha(path) {
      if (this.hasTree()) return this.treeMap.get(path) || null;
      if (this.shaCache.has(path)) return this.shaCache.get(path);
      const { owner, repo, branch } = this.config;
      const file = await LGS.github.files.getFile(this.token, owner, repo, path, branch);
      const sha = file.exists ? file.sha : null;
      this.shaCache.set(path, sha);
      return sha;
    }

    async getContent(path) {
      const { owner, repo, branch } = this.config;
      const file = await LGS.github.files.getFile(this.token, owner, repo, path, branch);
      return file.exists ? file.content : null;
    }

    _remember(path, sha) {
      this.shaCache.set(path, sha);
      if (this.treeMap) this.treeMap.set(path, sha);
    }

    /**
     * Create/update `path` so it contains `content`.
     * @returns {{action: 'created'|'updated'|'unchanged', sha: string}}
     */
    async put(path, content, message) {
      const { owner, repo, branch } = this.config;
      const localSha = await gitBlobSha(content);
      let existingSha = await this.getSha(path);
      if (existingSha === localSha) return { action: 'unchanged', sha: existingSha };

      const MAX = 4;
      for (let attempt = 0; attempt < MAX; attempt++) {
        try {
          const res = await LGS.sync.retry.withRetry(() => LGS.github.files.putFile(this.token, owner, repo, {
            path, content, message, branch, sha: existingSha || undefined
          }));
          this._remember(path, res.sha);
          this.writes++;
          if (this.writeDelayMs) await sleep(this.writeDelayMs);
          return { action: existingSha ? 'updated' : 'created', sha: res.sha };
        } catch (err) {
          const body = err && err.body ? JSON.stringify(err.body) : '';
          const stale = err && err.code === 'GITHUB_API_ERROR' && (err.status === 409 || (err.status === 422 && /sha/i.test(body)));
          if (!stale || attempt === MAX - 1) throw err;

          // Someone (or something) changed the file/branch: fetch the LATEST state.
          LGS.logger.warn('GitHub conflict writing', path, '- refreshing sha and retrying');
          const latest = await LGS.github.files.getFile(this.token, owner, repo, path, branch);
          existingSha = latest.exists ? latest.sha : null;
          this._remember(path, existingSha);
          if (latest.exists && latest.content === content) return { action: 'unchanged', sha: existingSha };
          await sleep(400 * (attempt + 1));
        }
      }
      throw LGS.errors.makeError('GITHUB_API_ERROR', 'Could not write file after several conflict retries.', { status: 409 });
    }
  }

  LGS.github = LGS.github || {};
  LGS.github.GithubSession = GithubSession;
})(typeof self !== 'undefined' ? self : window);
