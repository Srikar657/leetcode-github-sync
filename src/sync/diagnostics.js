/**
 * diagnostics.js  (src/sync/)
 *
 * The "check everything" engine behind Control Center → Diagnostics.
 * It tests every external dependency independently and reports exactly
 * what works, what does not, and what to do about it - including what
 * LeetCode's list responses look like (is `statusDisplay` null?).
 * It is strictly READ-ONLY: nothing is written to GitHub or LeetCode.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function chk(id, title, status, detail, hint) {
    return { id, title, status, detail: detail || '', hint: hint || null };
  }

  async function safe(fn) {
    const t0 = Date.now();
    try { return { ok: true, ms: Date.now() - t0, value: await fn() }; }
    catch (err) { return { ok: false, ms: Date.now() - t0, error: err }; }
  }

  function describeFields(f) {
    if (!f) return '';
    const present = Object.entries(f.present || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    return present ? `status fields present: ${present}` : 'NO status field present in the list items';
  }

  function listCheck(id, title, res) {
    if (!res) return chk(id, title, 'skip', 'Not run.');
    if (!res.ok) return chk(id, title, 'warn', `${res.error.message}`, 'Only one list source has to work - the extension falls back automatically.');
    const v = res.value;
    const c = v.statusCounts;
    const detail = `${v.count} submission(s) returned in ${res.ms} ms · Accepted ${c.accepted}, other ${c.notAccepted}, status unknown ${c.unknown} · ${describeFields(v.fields)}`;
    if (v.count > 0 && c.unknown === v.count) {
      return chk(id, title, 'warn', detail, 'This source returns no status in the list (the "statusDisplay: null" case). That is handled: every candidate is verified through the submission detail before anything is synced.');
    }
    return chk(id, title, 'pass', detail);
  }

  async function run() {
    const checks = [];
    const add = (c) => checks.push(c);

    add(chk('version', 'Extension', 'pass', `LeetCode GitHub Sync v${LGS.CONST.VERSION}`));

    /* ---------- GitHub ---------- */
    const config = await LGS.github.auth.loadConfig();
    if (!config) {
      add(chk('gh-config', 'GitHub configuration', 'fail', 'No repository/token saved.', 'Control Center → Settings → fill in owner, repository, branch and token, then Save.'));
    } else {
      add(chk('gh-config', 'GitHub configuration', 'pass', `${config.owner}/${config.repo} @ ${config.branch}`));
      const conn = await LGS.github.repository.testConnection(config);
      add(conn.ok
        ? chk('gh-conn', 'GitHub connection & branch', conn.canWrite ? 'pass' : 'fail', `${conn.repository}@${conn.branch} (${conn.isPrivate ? 'private' : 'public'})${conn.canWrite ? ', write access OK' : ''}`, conn.warning)
        : chk('gh-conn', 'GitHub connection & branch', 'fail', conn.message, 'Check owner/repo spelling, the branch name and the token permissions (Contents: Read and write).'));

      const rate = await safe(() => LGS.github.repository.getRateLimit(config.token));
      if (rate.ok && rate.value && rate.value.resources) {
        const core = rate.value.resources.core;
        add(chk('gh-rate', 'GitHub API quota', core.remaining < 200 ? 'warn' : 'pass', `${core.remaining}/${core.limit} requests left this hour`,
          core.remaining < 200 ? 'Low quota: a large sync may pause until it resets - that is handled automatically.' : null));
      } else add(chk('gh-rate', 'GitHub API quota', 'warn', rate.ok ? 'Unavailable' : rate.error.message));

      if (conn.ok) {
        const tree = await safe(async () => {
          const s = new LGS.github.GithubSession(config);
          return s.loadTree();
        });
        add(tree.ok
          ? chk('gh-tree', 'Repository file index', tree.value.truncated ? 'warn' : 'pass', `${tree.value.files} file(s) read in ${tree.ms} ms`, tree.value.truncated ? 'Repository is very large: GitHub truncated the listing, so per-file lookups will be used (slower but correct).' : null)
          : chk('gh-tree', 'Repository file index', 'fail', tree.error.message));
      }
    }

    /* ---------- LeetCode ---------- */
    const probe = await safe(() => LGS.syncManager.defaultBridge.probe({ sampleSize: 20 }));
    if (!probe.ok) {
      add(chk('lc-tab', 'LeetCode tab / content script', 'fail', probe.error.message,
        'Open https://leetcode.com in a tab, make sure you are logged in, then re-run. If you just installed/reloaded the extension, refresh the LeetCode tab.'));
    } else {
      const p = probe.value;
      add(chk('lc-tab', 'LeetCode tab / content script', 'pass', 'A LeetCode tab answered.'));

      if (p.auth.ok && p.auth.value.isSignedIn) add(chk('lc-auth', 'LeetCode login', 'pass', p.auth.value.username ? `Signed in as ${p.auth.value.username}` : 'Signed in'));
      else if (p.auth.ok) add(chk('lc-auth', 'LeetCode login', 'fail', 'Not signed in.', 'Log into leetcode.com in your browser.'));
      else add(chk('lc-auth', 'LeetCode login', p.auth.error.code === 'LEETCODE_NOT_AUTHENTICATED' ? 'fail' : 'warn', p.auth.error.message,
        p.auth.error.code === 'LEETCODE_BLOCKED' ? 'Open leetcode.com and complete the Cloudflare check.' : 'Log into leetcode.com in your browser.'));

      add(listCheck('lc-rest', 'Submission list - REST (/api/submissions/)', p.rest));
      add(listCheck('lc-gql', 'Submission list - GraphQL (submissionList)', p.graphql));
      if (!p.rest.ok && !p.graphql.ok) {
        add(chk('lc-list', 'At least one submission-list source', 'fail', 'Both list sources failed.',
          'If you are logged in, LeetCode may have changed its API. The solved-problem list (below) can still be used to back-fill problem by problem.'));
      } else add(chk('lc-list', 'At least one submission-list source', 'pass', `Using: ${[p.rest.ok && 'REST', p.graphql.ok && 'GraphQL'].filter(Boolean).join(' + ')}`));

      if (p.detail.skipped) add(chk('lc-detail', 'Submission detail (code + verified status)', 'skip', 'No submission available to test.'));
      else if (!p.detail.ok) add(chk('lc-detail', 'Submission detail (code + verified status)', 'fail', p.detail.error.message, 'Without submission detail the extension cannot fetch exact code, so historical sync cannot run.'));
      else {
        const d = p.detail.value;
        if (d.empty) add(chk('lc-detail', 'Submission detail (code + verified status)', 'fail', 'LeetCode returned no detail for the sample submission.'));
        else if (!d.hasCode) add(chk('lc-detail', 'Submission detail (code + verified status)', 'fail', 'Detail returned but without code.'));
        else if (!d.status) add(chk('lc-detail', 'Submission detail (code + verified status)', 'warn', `Code OK (${d.codeLength} chars) but NO status in the detail.`, 'Accepted can then only be confirmed from the list status. Submissions with no status anywhere are skipped (never guessed).'));
        else add(chk('lc-detail', 'Submission detail (code + verified status)', 'pass', `Status "${d.status}" read from ${d.statusSource}; code ${d.codeLength} chars; question number ${d.hasFrontendId ? 'present' : 'filled from metadata query'}.`));
      }

      add(p.stats.ok && p.stats.value
        ? chk('lc-stats', 'Verified solved count', 'pass', `LeetCode says ${p.stats.value.all} solved (Easy ${p.stats.value.easy}, Medium ${p.stats.value.medium}, Hard ${p.stats.value.hard}).`)
        : chk('lc-stats', 'Verified solved count', 'warn', p.stats.ok ? 'Not available.' : p.stats.error.message, 'Optional: the README then shows only the number of problems synced to GitHub.'));

      add(p.solved.ok
        ? chk('lc-solved', 'Solved-problem list', 'pass', `${p.solved.value.total} total, first page returned ${p.solved.value.firstPage}.`)
        : chk('lc-solved', 'Solved-problem list', 'warn', p.solved.error.message, 'Optional: used to cross-check coverage and to fill gaps.'));
    }

    /* ---------- extension internals ---------- */
    add(chk('alarms', 'Background resume (alarms)', global.chrome && chrome.alarms ? 'pass' : 'fail', global.chrome && chrome.alarms ? 'Alarm API available.' : 'Alarms permission missing.'));
    const progress = await LGS.sync.historicalSync.getProgress();
    const pend = await LGS.sync.decisions.list();
    const retryList = await LGS.storage.getRetryList();
    add(chk('job', 'Background job state', 'pass',
      `Historical sync: ${progress.state}${progress.mode === 'dry-run' ? ' (dry run)' : ''} · failed items: ${retryList.length} · waiting for your decision: ${pend.length}`));

    const report = { at: LGS.formatter.nowIso(), checks, ok: !checks.some((c) => c.status === 'fail') };
    await LGS.storage.setKey(LGS.CONST.STORAGE_KEYS.DIAGNOSTICS, report);
    return report;
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.diagnostics = { run };
})(typeof self !== 'undefined' ? self : window);
