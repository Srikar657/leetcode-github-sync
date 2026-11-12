/**
 * decisions.js  (src/sync/)
 *
 * Real implementation of the "Ask" duplicate mode (review item 9).
 * When a solution file already exists on GitHub with DIFFERENT content and
 * the setting is "ask", nothing is written. The proposed solution is parked
 * here and shown in the Control Center, where you choose per item (or for
 * all items): overwrite GitHub's version, or keep it.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const KEY = () => LGS.CONST.STORAGE_KEYS.PENDING_DECISIONS;
  const lock = LGS.formatter.createMutex();

  function list() { return LGS.storage.getKey(KEY(), []); }

  function add(model, info) {
    return lock(async () => {
      const items = await list();
      const id = LGS.formatter.randomId();
      const entry = {
        id,
        path: info.path,
        title: model.title,
        number: model.problemNumber,
        language: model.language,
        submissionId: model.submissionId,
        createdAt: LGS.formatter.nowIso(),
        model
      };
      const next = items.filter((i) => i.path !== info.path);
      next.push(entry);
      await LGS.storage.setKey(KEY(), next);
      return entry;
    });
  }

  function removeIds(ids) {
    return lock(async () => {
      const set = new Set(ids);
      const items = await list();
      await LGS.storage.setKey(KEY(), items.filter((i) => !set.has(i.id)));
    });
  }

  /** Light view for the UI (no source code). */
  async function listPublic() {
    return (await list()).map(({ model, ...rest }) => Object.assign(rest, {
      newCodeLines: model && model.code ? model.code.split('\n').length : 0,
      githubUrl: null
    }));
  }

  /**
   * @param {string|'all'} idOrAll
   * @param {'overwrite'|'keep'} action
   */
  async function resolve(idOrAll, action) {
    const items = await list();
    const targets = idOrAll === 'all' ? items : items.filter((i) => i.id === idOrAll);
    if (!targets.length) return { resolved: 0, failed: 0, errors: [] };

    if (action === 'keep') {
      await removeIds(targets.map((t) => t.id));
      return { resolved: targets.length, failed: 0, errors: [] };
    }

    const config = await LGS.github.auth.loadConfig();
    if (!config) throw LGS.errors.makeError('GITHUB_NOT_CONFIGURED', 'GitHub is not configured yet.');
    const settings = await LGS.storage.getSettings();
    const session = new LGS.github.GithubSession(config, { writeDelayMs: settings.githubWriteDelayMs });

    let resolved = 0;
    const errors = [];
    for (const t of targets) {
      try {
        await LGS.sync.currentSync.syncSubmissionModel(t.model, { source: 'decision', forceUpdate: true, session, deferReadme: true, quiet: true });
        await removeIds([t.id]);
        resolved++;
      } catch (err) {
        errors.push(`${t.title || t.path}: ${err.message}`);
      }
    }
    if (resolved && settings.updateRepoReadme) {
      try { await LGS.sync.publisher.publishMainReadme(session); } catch (e) { errors.push('README: ' + e.message); }
    }
    return { resolved, failed: errors.length, errors };
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.decisions = { add, list, listPublic, resolve, removeIds };
})(typeof self !== 'undefined' ? self : window);
