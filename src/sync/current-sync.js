/**
 * current-sync.js  (src/sync/)
 *
 * `syncSubmissionModel` is the SINGLE choke point every code path goes
 * through before anything is written to GitHub. It re-checks the
 * Accepted-only rule itself (defense in depth - it never trusts a caller),
 * resolves duplicates, writes, updates the index/READMEs, records history.
 *
 * Also: "Sync Current" / "Sync problem" - which no longer depend on what the
 * page happened to display. They ask LeetCode for the newest VERIFIED
 * Accepted submission of the problem (review item 3).
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { ACCEPTED_STATUS } = LGS.CONST;

  class SyncRefusedError extends Error {
    constructor(message, reason) {
      super(message);
      this.code = 'SYNC_REFUSED';
      this.reason = reason || 'status';
    }
  }

  function notify(title, message) {
    try {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
    } catch (e) {
      LGS.logger.warn('Notification failed to display:', e.message);
    }
  }

  /**
   * @param {object} model normalized submission model
   * @param {object} [opts]
   * @param {string} [opts.source]       'auto' | 'current' | 'historical' | 'decision' | 'retry' | 'manual'
   * @param {GithubSession} [opts.session] shared session (batch jobs)
   * @param {boolean} [opts.deferReadme]  do not touch the main README (caller does it once)
   * @param {boolean} [opts.dryRun]       compute the outcome, write NOTHING
   * @param {boolean} [opts.forceUpdate]  overwrite even if "skip"/"ask" would apply
   * @param {boolean} [opts.quiet]        no per-item notification
   * @returns {object} a record describing what happened (record.action)
   */
  async function syncSubmissionModel(model, opts = {}) {
    // --- Non-negotiable safety gate -------------------------------------
    if (!model || model.status !== ACCEPTED_STATUS) {
      throw new SyncRefusedError(
        `Refusing to sync. Current submission is not Accepted (status: ${model ? model.status : 'unknown'}).`
      );
    }
    const issues = LGS.leetcode.metadata.problemsWith(model);
    if (issues.length) {
      throw new SyncRefusedError(`Refusing to sync. Required problem data is missing: ${issues.join('; ')}.`, 'metadata');
    }
    // ---------------------------------------------------------------------

    const source = opts.source || 'manual';
    const githubConfig = await LGS.github.auth.loadConfig();
    if (!githubConfig) {
      throw LGS.errors.makeError('GITHUB_NOT_CONFIGURED', 'GitHub is not configured yet. Open the Control Center → Settings to connect a repository.');
    }
    const settings = await LGS.storage.getSettings();
    const session = opts.session || new LGS.github.GithubSession(githubConfig);
    const retry = LGS.sync.retry.withRetry;

    // Guard against one submission firing twice (e.g. two tabs) - auto only.
    if (source === 'auto' && model.submissionId) {
      const seen = await LGS.storage.getSyncedSubmissionIds();
      if (seen.has(String(model.submissionId))) {
        return { problemNumber: model.problemNumber, title: model.title, status: model.status, action: 'skipped-duplicate-submission', syncedAt: LGS.formatter.nowIso() };
      }
    }

    const paths = LGS.sync.duplicateChecker.computeTargetPaths(model);
    const content = LGS.formatter.normalizeSource(model.code);
    const localSha = await LGS.formatter.gitBlobSha(content);
    const existingSha = await retry(() => session.getSha(paths.solutionPath));

    const base = {
      problemNumber: model.problemNumber, title: model.title, slug: model.slug,
      difficulty: model.difficulty, language: model.language, extension: model.extension,
      languageUnknown: !!model.languageUnknown, submissionId: model.submissionId, status: model.status,
      githubPath: paths.solutionPath, githubFolder: paths.folder, topics: model.topics, source,
      syncedAt: LGS.formatter.nowIso()
    };

    // ---- decide ----
    let decision; // 'unchanged' | 'write' | 'skip' | 'ask'
    if (existingSha && existingSha === localSha) decision = 'unchanged';
    else if (existingSha && !opts.forceUpdate) {
      decision = settings.duplicateHandling === 'skip' ? 'skip' : settings.duplicateHandling === 'ask' ? 'ask' : 'write';
    } else decision = 'write';

    if (opts.dryRun) {
      const action = { unchanged: 'unchanged', skip: 'would-skip-existing', ask: 'would-ask', write: existingSha ? 'would-update' : 'would-create' }[decision];
      return Object.assign(base, { action, dryRun: true });
    }

    // ---- act ----
    let action;
    if (decision === 'unchanged') action = 'unchanged';
    else if (decision === 'skip') action = 'skipped-existing';
    else if (decision === 'ask') {
      await LGS.sync.decisions.add(model, { path: paths.solutionPath });
      action = 'pending-decision';
      if (settings.notifications && !opts.quiet) {
        notify('Solution needs your decision', `${model.title || model.slug} differs from GitHub. Open the Control Center → Decisions.`);
      }
    } else {
      const msg = `${existingSha ? 'Update' : 'Add'} solution: ${model.title || model.slug} (${model.language})`;
      const put = await session.put(paths.solutionPath, content, msg);
      action = put.action;
    }

    // The file now exists in the repo either way: record it in the index.
    let entry = null;
    await LGS.sync.indexStore.update((index) => {
      entry = LGS.sync.indexStore.upsertFromModel(index, model, paths);
    });

    // Secondary files are best-effort and must never lose the solution record.
    if (settings.generateProblemReadme && (action === 'created' || action === 'updated' || action === 'unchanged')) {
      try { await LGS.sync.publisher.publishProblemReadme(session, entry); }
      catch (err) { LGS.logger.warn('Problem README update failed (solution file was still synced):', err.message); }
    }

    const record = Object.assign(base, { action });
    if (action === 'created' || action === 'updated') await LGS.storage.addSyncHistoryEntry(record);
    if (model.submissionId && (action === 'created' || action === 'updated' || action === 'unchanged')) {
      await LGS.storage.addSyncedSubmissionId(model.submissionId);
    }

    if (settings.updateRepoReadme && !opts.deferReadme) {
      try { await LGS.sync.publisher.publishMainReadme(session); }
      catch (err) { LGS.logger.warn('Main README update failed:', err.message); }
    }

    if (settings.notifications && !opts.quiet && (action === 'created' || action === 'updated')) {
      notify('✓ LeetCode Accepted', `${model.title || model.slug} was synchronized to GitHub.`);
    }
    return record;
  }

  /** Model from a bridge `resolveProblem` result (verified Accepted). */
  function modelFromResolved(res) {
    const dq = (res.detail && res.detail.question) || {};
    const meta = res.meta || {};
    const sub = res.submission || {};
    return LGS.leetcode.metadata.buildSubmissionModel({
      submissionId: sub.id,
      problem: {
        number: dq.frontendId || meta.number,
        title: dq.title || meta.title,
        slug: dq.titleSlug || meta.slug || res.slug,
        difficulty: dq.difficulty || meta.difficulty,
        tags: (dq.topicTags && dq.topicTags.length) ? dq.topicTags : (meta.tags || [])
      },
      rawLanguage: res.detail.langName || res.detail.langSlug || sub.langName || sub.lang,
      code: res.detail.code,
      status: res.verdict.accepted ? ACCEPTED_STATUS : res.verdict.status,
      runtime: res.detail.runtime || sub.runtime,
      memory: res.detail.memory || sub.memory,
      timestamp: (sub.timestamp || 0) * 1000 || Date.now()
    });
  }

  /** Sync the newest verified Accepted submission of ONE problem. */
  async function syncProblem(slug, { preferLanguageLabel = null, source = 'current' } = {}) {
    const clean = String(slug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(clean)) {
      throw new SyncRefusedError('That does not look like a LeetCode problem slug (e.g. "two-sum").', 'metadata');
    }
    const preferLangSlug = preferLanguageLabel ? LGS.languages.resolveLanguage(preferLanguageLabel).slug : null;
    const res = await LGS.sync.retry.withRetry(
      () => LGS.syncManager.defaultBridge.resolveProblem(clean, { preferLangSlug })
    );
    if (!res || !res.accepted) {
      throw new SyncRefusedError(
        `Refusing to sync. No Accepted submission was found for "${clean}"` +
        `${res && res.latestStatus ? ` (latest submission: ${res.latestStatus})` : ''}.`
      );
    }
    return syncSubmissionModel(modelFromResolved(res), { source });
  }

  /** "Sync Current Accepted": the problem in the tab you are looking at. */
  async function syncCurrent() {
    const tab = await LGS.syncManager.getCurrentProblemTab();
    if (!tab) {
      throw LGS.errors.makeError('LEETCODE_NO_ACTIVE_TAB',
        'Open a LeetCode problem page (leetcode.com/problems/…) in a tab first - or use "Sync a problem by slug" in the Control Center.');
    }
    return syncProblem(tab.slug, { preferLanguageLabel: tab.language, source: 'current' });
  }

  /** Remember a failed live sync so it can be retried from the Failed tab. */
  async function recordModelFailure(model, err, source) {
    const c = LGS.errors.classify(err);
    await LGS.sync.retry.addToRetryList({
      kind: 'model', model, source,
      title: model && model.title, slug: model && model.slug, language: model && model.language,
      error: err.message, category: c.category, retryable: c.autoRetry, failedAt: LGS.formatter.nowIso()
    });
  }

  async function retryModelItems(items) {
    let ok = 0; const errors = [];
    for (const item of items) {
      try {
        await syncSubmissionModel(item.model, { source: 'retry' });
        await LGS.sync.retry.removeFromRetryList((i) => i.id === item.id);
        ok++;
      } catch (err) { errors.push(`${item.title || item.slug}: ${err.message}`); }
    }
    return { ok, errors };
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.currentSync = {
    syncSubmissionModel, syncProblem, syncCurrent, modelFromResolved,
    recordModelFailure, retryModelItems, SyncRefusedError
  };
})(typeof self !== 'undefined' ? self : window);
