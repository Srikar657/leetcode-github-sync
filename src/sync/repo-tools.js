/**
 * repo-tools.js  (src/sync/)
 *
 * Maintenance operations exposed in the Control Center → Repository tab:
 *   - rebuildIndex       : learn what is really in the GitHub repo
 *   - regenerateReadmes  : rewrite README.md / TOPICS.md (/ problem READMEs)
 *   - verifyCoverage     : compare LeetCode's own solved list with the repo
 *   - migrateFromHistory : upgrade path from v1 (history -> index)
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  async function newSession({ delay = true } = {}) {
    const config = await LGS.github.auth.loadConfig();
    if (!config) throw LGS.errors.makeError('GITHUB_NOT_CONFIGURED', 'GitHub is not configured yet. Open Settings to connect a repository.');
    const settings = await LGS.storage.getSettings();
    return { session: new LGS.github.GithubSession(config, { writeDelayMs: delay ? settings.githubWriteDelayMs : 0 }), settings, config };
  }

  async function rebuildIndex() {
    const { session } = await newSession({ delay: false });
    const info = await session.loadTree();
    let added = 0;
    const stats = await LGS.sync.indexStore.update((index) => {
      added = LGS.sync.indexStore.mergeFromRepoPaths(index, session.paths());
      return LGS.sync.indexStore.stats(index);
    });
    return Object.assign({ added, filesInRepo: info.files, truncated: info.truncated }, stats);
  }

  async function regenerateReadmes({ problemReadmes = false } = {}) {
    const { session } = await newSession();
    await session.loadTree();
    const index = await LGS.sync.indexStore.load();
    const entries = LGS.sync.indexStore.toList(index);
    if (!entries.length) throw LGS.errors.makeError('SYNC_REFUSED', 'Nothing to generate yet - the solution index is empty. Run "Rebuild index from GitHub" or sync some solutions first.', { reason: 'metadata' });

    if (problemReadmes) {
      for (const entry of entries) {
        await LGS.sync.retry.withRetry(() => LGS.sync.publisher.publishProblemReadme(session, entry));
      }
    }
    await LGS.sync.retry.withRetry(() => LGS.sync.publisher.publishMainReadme(session));
    return { problems: entries.length, filesWritten: session.writes };
  }

  async function verifyCoverage() {
    const rebuilt = await rebuildIndex().catch((err) => ({ error: err.message }));
    const solved = await LGS.sync.retry.withRetry(() => LGS.syncManager.defaultBridge.listSolved());
    let stats = null;
    try {
      stats = await LGS.syncManager.defaultBridge.getSolvedStats();
      if (stats) await LGS.storage.setKey(LGS.CONST.STORAGE_KEYS.LEETCODE_STATS, Object.assign({}, stats, { fetchedAt: LGS.formatter.nowIso() }));
    } catch (err) { LGS.logger.warn('Solved stats unavailable:', err.message); }

    const index = await LGS.sync.indexStore.load();
    const missing = solved.items.filter((i) => !LGS.sync.indexStore.hasProblem(index, i.slug));
    const inRepoCount = solved.items.length - missing.length;
    return {
      leetcodeSolved: stats ? stats.all : solved.total,
      listed: solved.items.length,
      inRepo: inRepoCount,
      repoProblems: LGS.sync.indexStore.stats(index).problems,
      missing: missing.map((m) => ({ slug: m.slug, number: m.number, title: m.title, difficulty: m.difficulty })),
      indexRebuilt: rebuilt
    };
  }

  /** v1 -> v2: build the index from the old activity history. */
  async function migrateFromHistory() {
    const history = await LGS.storage.getSyncHistory();
    if (!history.length) return 0;
    let n = 0;
    await LGS.sync.indexStore.update((index) => {
      if (Object.keys(index).length) return;
      for (const r of history.slice().reverse()) {
        if (!r.githubFolder || !r.githubPath) continue;
        const ext = r.githubPath.split('/').pop().replace(/^solution\./, '');
        const entry = index[r.githubFolder] || { folder: r.githubFolder, files: {} };
        Object.assign(entry, { number: r.problemNumber, title: r.title, difficulty: r.difficulty, slug: (r.githubFolder.split('/')[1] || '').replace(/^\d+-/, ''), topics: r.topics });
        entry.url = entry.slug ? `https://leetcode.com/problems/${entry.slug}/` : null;
        entry.files[ext] = { language: r.language, path: r.githubPath, submissionId: r.submissionId, runtime: null, memory: null, syncedAt: r.syncedAt };
        index[r.githubFolder] = entry;
        n++;
      }
    });
    return n;
  }

  async function getIndexView() {
    const index = await LGS.sync.indexStore.load();
    return {
      stats: LGS.sync.indexStore.stats(index),
      entries: LGS.sync.indexStore.toList(index).map((e) => ({
        folder: e.folder, number: e.number, title: e.title, slug: e.slug, difficulty: e.difficulty,
        languages: Object.values(e.files || {}).map((f) => f.language)
      }))
    };
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.repoTools = { rebuildIndex, regenerateReadmes, verifyCoverage, migrateFromHistory, getIndexView };
})(typeof self !== 'undefined' ? self : window);
