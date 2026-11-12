/**
 * dashboard.js - Control Center.
 *
 * Talks to the background service worker only through chrome.runtime
 * messages. All dynamic content is inserted with textContent (never
 * innerHTML), so problem titles / error text coming from LeetCode or GitHub
 * can never inject markup into this extension page.
 */
(function () {
  const { MSG } = LGS.CONST;
  const $ = (id) => document.getElementById(id);

  /* ------------------------------ helpers ------------------------------ */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('No response from the background worker.'));
        if (resp.ok === false) return reject(Object.assign(new Error(resp.error || 'Request failed'), { code: resp.code }));
        resolve(resp.data);
      });
    });
  }

  let toastTimer = null;
  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
  }

  function showResult(id, kind, text) {
    const el = $(id);
    if (!text) { el.hidden = true; return; }
    el.className = `result ${kind}`; el.textContent = text; el.hidden = false;
  }

  function busy(btn, label, fn) {
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    return Promise.resolve().then(fn).finally(() => { btn.disabled = false; btn.textContent = original; });
  }

  const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch (e) { return ''; } };
  const parseSlug = (input) => {
    const m = /problems\/([a-z0-9-]+)/i.exec(input || '');
    return (m ? m[1] : String(input || '').trim()).toLowerCase();
  };

  /* ------------------------------ tabs ------------------------------ */
  const TABS = ['progress', 'historical', 'failed', 'decisions', 'repository', 'diagnostics', 'settings', 'logs'];
  const loaders = {};
  function parseHash() {
    const [name, qs] = location.hash.slice(1).split('?');
    return { name, params: new URLSearchParams(qs || '') };
  }
  function showTab(name, params) {
    if (!TABS.includes(name)) name = 'progress';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    const wanted = `#${name}${params && params.toString() ? '?' + params.toString() : ''}`;
    if (location.hash !== wanted) history.replaceState(null, '', wanted);
    if (loaders[name]) loaders[name](params).catch((e) => toast(e.message, true));
  }

  /* ------------------------------ state ------------------------------ */
  let state = null;
  async function refreshState() {
    state = await send(MSG.GET_STATE);
    $('versionText').textContent = `v${state.version}`;
    const cfg = state.githubConfig;
    const badge = $('connBadge');
    badge.className = 'badge ' + (cfg && cfg.hasToken ? 'badge-muted' : 'badge-muted');
    badge.textContent = cfg && cfg.hasToken ? '● GitHub connected' : '○ GitHub not connected';
    badge.title = cfg && cfg.hasToken ? `${cfg.owner}/${cfg.repo} @ ${cfg.branch}` : 'Set up in Settings';
    badge.style.cursor = 'pointer'; badge.onclick = () => showTab('settings');
    setPill('failedCount', state.retryCount);
    setPill('decisionCount', state.pendingDecisions);
    return state;
  }
  function setPill(id, n) { const el = $(id); el.textContent = n; el.hidden = !n; }

  /* ------------------------------ progress (analytics) ------------------------------ */
  const U = LGS.ui;
  let snap = null; let importing = false;
  const openProblem = (slug) => chrome.tabs.create({ url: `https://leetcode.com/problems/${slug}/` });

  function alertBox(kind, text, actionLabel, action) {
    return h('div', { class: `result ${kind} alert` }, text, actionLabel ? h('button', { class: 'btn btn-secondary btn-sm', style: 'margin-left:10px', onclick: action, text: actionLabel }) : null);
  }

  function renderStats() {
    if (!snap) return;
    const s = state;
    const box = clear($('progAlerts'));
    if (s) {
      if (!s.githubConfig || !s.githubConfig.hasToken) box.append(alertBox('info', 'GitHub backup is not connected. Your progress tracking works without it; connect it to also save every solved problem to a repository.', 'Connect', () => showTab('settings')));
      if (s.failedSaves) box.append(alertBox('warn', `${s.failedSaves} solution(s) could not be saved to GitHub yet. They are still counted as solved.`, 'Retry now', async () => { await send(MSG.RETRY_SAVE, { id: 'all' }); toast('Retrying…'); }));
      if (s.pendingDecisions) box.append(alertBox('info', `${s.pendingDecisions} solution(s) differ from GitHub and wait for your decision.`, 'Review', () => showTab('decisions')));
      const hp = s.historicalProgress;
      if (hp && ['paused', 'waiting', 'error'].includes(hp.state)) box.append(alertBox(hp.state === 'error' ? 'error' : 'warn', `Historical sync is ${hp.state}${hp.error ? ': ' + hp.error : ''}`, 'Open', () => showTab('historical')));
    }
    const liveCard = U.live(snap, { retrySave: async () => { await send(MSG.RETRY_SAVE, { id: 'all' }); } });
    clear($('progLive')); if (liveCard) $('progLive').append(liveCard);

    const body = clear($('progBody'));
    const c1 = h('div', { class: 'col' }); const c2 = h('div', { class: 'col' }); const c3 = h('div', { class: 'col' });
    c1.append(U.hero(snap));
    if (!snap.hasData) c1.append(U.emptyState(importHistory, importing));
    c1.append(U.statTiles(snap), U.today(snap), U.streakTiles(snap), U.difficulty(snap));
    c2.append(U.recent(snap, 12, openProblem), U.languages(snap));
    c3.append(U.topics(snap, 12, applyTopicFilter), U.heatmap(snap), U.week(snap), U.month(snap));
    body.append(c1, c2, c3);

    const sel = $('probTopic'); const keep = sel.value || 'All';
    clear(sel); sel.append(h('option', { value: 'All', text: 'All topics' }));
    snap.topics.forEach((t) => sel.append(h('option', { value: t.name, text: `${t.name} (${t.count})` })));
    sel.value = snap.topics.some((t) => t.name === keep) ? keep : 'All';
    $('progUpdated').textContent = snap.lastRefreshAt ? `Updated ${U.relTime(Math.floor(snap.lastRefreshAt / 1000))}${snap.historyComplete ? '' : ' · history not fully imported'}` : 'Not yet refreshed from LeetCode';
  }

  async function importHistory() {
    importing = true; renderStats();
    try { await send(MSG.REFRESH_STATS, { full: true }); toast('History imported.'); }
    catch (e) { toast(e.message, true); }
    importing = false; await loaders.progress();
  }

  let probTimer = null;
  async function loadProblems() {
    const list = await send(MSG.GET_PROBLEMS, { query: $('probSearch').value, difficulty: $('probDiff').value, topic: $('probTopic').value });
    $('problemCount').textContent = `(${list.length})`;
    const box = clear($('probList'));
    if (!list.length) { box.append(h('div', { class: 'empty' }, 'No solved problems match.')); return; }
    list.slice(0, 400).forEach((p) => box.append(h('div', { class: 'prow', title: [p.runtime && `Runtime ${p.runtime}`, p.memory && `Memory ${p.memory}`].filter(Boolean).join(' · '), onclick: () => openProblem(p.slug) },
      h('span', { class: 'no', text: p.number ? `#${p.number}` : '' }),
      h('div', {}, h('div', { class: 'nm', text: p.title }), h('div', { class: 'tg' }, p.difficulty ? h('span', { class: `diff-${p.difficulty}`, text: p.difficulty }) : '', p.topics.length ? ` · ${p.topics.join(', ')}` : '')),
      h('div', { class: 'rt', text: `${p.languages.join(', ')}${p.lastAt ? ' · ' + U.relTime(p.lastAt) : ''}` }))));
  }
  function applyTopicFilter(topic) {
    $('probTopic').value = topic; loadProblems();
    $('problemsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  ['probSearch'].forEach((id) => $(id).addEventListener('input', () => { clearTimeout(probTimer); probTimer = setTimeout(loadProblems, 200); }));
  ['probDiff', 'probTopic'].forEach((id) => $(id).addEventListener('change', loadProblems));

  loaders.progress = async function (params) {
    const [s] = await Promise.all([send(MSG.GET_STATS), refreshState()]);
    snap = s; renderStats();
    if (params && params.get('topic')) { const t = params.get('topic'); if ([...$('probTopic').options].some((o) => o.value === t)) $('probTopic').value = t; await loadProblems(); $('problemsPanel').scrollIntoView(); }
    else await loadProblems();
  };
  $('progRefresh').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', async () => { try { await send(MSG.REFRESH_STATS, {}); } catch (err) { toast(err.message, true); } await loaders.progress(); }));
  $('progImport').addEventListener('click', (e) => busy(e.currentTarget, 'Importing…', importHistory));

  async function runSync(btn, payloadType, payload) {
    showResult('syncResult', 'info', 'Working…');
    await busy(btn, 'Syncing…', async () => {
      try {
        const r = await send(payloadType, payload);
        if (r.ok) {
          const rec = r.record;
          const labels = { created: 'Created', updated: 'Updated', unchanged: 'Already up to date', 'skipped-existing': 'Kept the existing GitHub file', 'pending-decision': 'Needs your decision (see Decisions)' };
          showResult('syncResult', 'success', `${labels[rec.action] || rec.action}: ${rec.title || rec.slug} (${rec.language}) → ${rec.githubPath}`);
        } else showResult('syncResult', 'error', r.message);
      } catch (e) { showResult('syncResult', 'error', e.message); }
    });
    refreshState();
  }
  $('syncCurrentBtn').addEventListener('click', (e) => runSync(e.currentTarget, MSG.SYNC_CURRENT));
  $('syncSlugBtn').addEventListener('click', (e) => {
    const slug = parseSlug($('slugInput').value);
    if (!slug) return showResult('syncResult', 'warn', 'Enter a problem slug or URL first.');
    runSync(e.currentTarget, MSG.SYNC_PROBLEM, { slug });
  });

  /* ------------------------------ historical ------------------------------ */
  const STATE_BADGE = {
    idle: ['Idle', 'badge-muted'], discovering: ['Scanning LeetCode…', 'badge-info'], running: ['Syncing…', 'badge-info'],
    paused: ['Paused', 'badge-warning'], waiting: ['Waiting (rate limit)', 'badge-warning'], completed: ['Completed', 'badge-success'],
    error: ['Error', 'badge-danger'], cancelled: ['Cancelled', 'badge-muted']
  };
  const PHASES = { preflight: 'Checking your LeetCode session', 'solved-list': 'Reading your solved-problem list', scanning: 'Scanning submission history', filling: 'Looking up remaining problems one by one', syncing: 'Verifying and syncing', finalizing: 'Finishing (README, verified counts)' };
  let lastProgress = null;

  function renderProgress(p) {
    if (!p) return;
    lastProgress = p;
    const [label, cls] = STATE_BADGE[p.state] || [p.state, 'badge-muted'];
    const badge = $('hState'); badge.textContent = label + (p.mode === 'dry-run' ? ' · dry run' : ''); badge.className = `badge ${cls}`;

    const active = ['discovering', 'running'].includes(p.state);
    const stalled = ['paused', 'waiting', 'error'].includes(p.state);
    $('hStart').hidden = active || stalled;
    $('hPause').hidden = !active;
    $('hResume').hidden = !stalled;
    $('hCancel').hidden = !(active || stalled);
    $('hRealRun').hidden = !(p.mode === 'dry-run' && p.state === 'completed');
    ['optDry', 'optNew', 'optReuse'].forEach((id) => { $(id).disabled = active || stalled; });

    const wrap = $('hProgress'); wrap.hidden = p.state === 'idle';
    $('hPhase').textContent = p.phase ? PHASES[p.phase] || p.phase : (p.state === 'completed' ? 'Finished' : '');
    const bar = $('hBar');
    if (p.state === 'discovering' || (p.state === 'running' && !p.total && p.phase !== 'finalizing')) { bar.classList.add('indeterminate'); bar.style.width = ''; }
    else { bar.classList.remove('indeterminate'); bar.style.width = p.total ? `${Math.min(100, Math.round((p.processed / p.total) * 100))}%` : (p.state === 'completed' ? '100%' : '0%'); }

    const dry = p.mode === 'dry-run';
    const cs = $('hCounters'); clear(cs);
    [[dry ? 'To check' : 'Candidates', p.total], ['Done', p.processed], [dry ? 'Would create' : 'New', p.created], [dry ? 'Would update' : 'Updated', p.updated],
      ['Unchanged', p.unchanged], [dry ? 'Would keep' : 'Kept (existing)', p.skippedExisting], ['Needs decision', p.pendingDecision], ['Not accepted', p.notAccepted],
      ['Failed', p.failed], ['Warnings', p.warnings]].forEach(([k, v]) => cs.append(h('span', {}, `${k}: `, h('strong', { text: String(v || 0) }))));
    $('hCurrent').textContent = p.state === 'completed' ? '' : (p.current || '');

    if (p.state === 'error') showResult('hMessage', 'error', p.error);
    else if (p.state === 'paused' || p.state === 'waiting') showResult('hMessage', 'warn', p.error || 'Paused. Press Resume to continue from where it stopped.');
    else if (p.state === 'completed' && p.summary) showResult('hMessage', 'success', p.summary);
    else showResult('hMessage', 'info', '');

    const d = p.discovery || {};
    const parts = [];
    if (d.scanned != null) parts.push(`${d.scanned} submissions scanned in ${d.pages} page(s) via ${d.source || '…'}`);
    if (d.candidates != null) parts.push(`${d.candidates} problem/language candidates`);
    if (d.solvedTotal != null) parts.push(`LeetCode lists ${d.solvedTotal} solved problems`);
    if (d.unresolved) parts.push(`${d.unresolved} solved problem(s) had no accepted submission we could locate`);
    if (d.skippedAlreadyInRepo) parts.push(`${d.skippedAlreadyInRepo} skipped (already in repository)`);
    if (d.scanError) parts.push('full-history scan unavailable, used per-problem lookup');
    $('hDiscovery').textContent = parts.join(' · ');
  }

  async function refreshProgress(withReport) {
    renderProgress(await send(MSG.GET_HISTORICAL_PROGRESS));
    if (withReport || (lastProgress && lastProgress.state === 'completed')) loadReport();
  }
  loaders.historical = () => refreshProgress(true);

  async function startHistorical(extra) {
    try {
      const p = await send(MSG.SYNC_HISTORICAL_START, Object.assign({ dryRun: $('optDry').checked, onlyNew: $('optNew').checked, reuseDiscovery: $('optReuse').checked }, extra || {}));
      renderProgress(p);
    } catch (e) { toast(e.message, true); }
  }
  $('hStart').addEventListener('click', () => startHistorical());
  $('hRealRun').addEventListener('click', () => { $('optDry').checked = false; $('hRealRun').hidden = true; startHistorical({ dryRun: false }); });
  $('hPause').addEventListener('click', async () => { renderProgress(await send(MSG.SYNC_HISTORICAL_PAUSE)); toast('Pausing after the current item…'); });
  $('hResume').addEventListener('click', async () => renderProgress(await send(MSG.SYNC_HISTORICAL_RESUME)));
  $('hCancel').addEventListener('click', async () => { if (confirm('Cancel the historical sync? Items already uploaded stay on GitHub.')) renderProgress(await send(MSG.SYNC_HISTORICAL_CANCEL)); });

  let reportData = null;
  const OUTCOME_LABEL = {
    'would-create': 'Would create', 'would-update': 'Would update', 'would-skip-existing': 'Would keep existing', 'would-ask': 'Would ask',
    created: 'Created', updated: 'Updated', unchanged: 'Unchanged', 'skipped-existing': 'Kept existing', 'pending-decision': 'Needs decision',
    'not-accepted': 'Not accepted', failed: 'Failed'
  };
  async function loadReport() {
    reportData = await send(MSG.GET_HISTORICAL_REPORT);
    const panel = $('reportPanel');
    if (!reportData || !reportData.items || !reportData.items.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const sel = $('reportFilter'); const current = sel.value || 'all';
    clear(sel);
    const counts = {}; reportData.items.forEach((i) => { counts[i.outcome] = (counts[i.outcome] || 0) + 1; });
    sel.append(h('option', { value: 'all', text: `All (${reportData.items.length})` }));
    Object.keys(counts).forEach((k) => sel.append(h('option', { value: k, text: `${OUTCOME_LABEL[k] || k} (${counts[k]})` })));
    sel.value = counts[current] || current === 'all' ? current : 'all';
    renderReport();
  }
  function renderReport() {
    const f = $('reportFilter').value;
    const body = $('reportTable').querySelector('tbody'); clear(body);
    (reportData.items || []).filter((i) => f === 'all' || i.outcome === f).forEach((i) => body.append(h('tr', {},
      h('td', { text: i.title || i.slug }), h('td', { text: i.lang || '' }), h('td', { text: OUTCOME_LABEL[i.outcome] || i.outcome }), h('td', { class: 'muted', text: i.reason || i.path || '' }))));
  }
  $('reportFilter').addEventListener('change', renderReport);
  $('reportDownload').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'leetcode-sync-report.json' });
    document.body.append(a); a.click(); a.remove();
  });

  /* ------------------------------ failed ------------------------------ */
  const CAT_BADGE = { rate_limit: 'badge-warning', network: 'badge-warning', server: 'badge-warning', github_conflict: 'badge-warning', auth: 'badge-danger', blocked: 'badge-danger', permission: 'badge-danger', schema: 'badge-danger', config: 'badge-danger' };
  const CAT_NAME = { permission_or_unknown: 'GitHub save', auth: 'LeetCode login', blocked: 'LeetCode blocked', rate_limit: 'Rate limit', network: 'Network', server: 'Server error', missing_code: 'Missing code', schema: 'API changed', github_conflict: 'GitHub conflict', permission: 'GitHub permission', config: 'Configuration', invalid_metadata: 'Invalid metadata', not_accepted: 'Not accepted', unknown: 'Unknown' };

  loaders.failed = async function () {
    await refreshState();
    const items = await send(MSG.GET_FAILED_ITEMS);
    const body = $('failedBody'); clear(body);
    if (!items.length) { body.append(h('p', { class: 'muted', text: 'Nothing needs attention.' })); return; }
    items.forEach((i) => body.append(h('div', { class: 'fail-item' },
      h('div', {},
        h('div', {}, h('strong', { text: i.title || i.slug || 'Unknown problem' }), ' ', h('span', { class: 'muted', text: i.language || '' })),
        h('div', { class: 'f-err', text: i.error }),
        h('div', { class: 'muted small', text: `${fmtTime(i.failedAt)} · ${i.kind === 'save' ? 'GitHub save (the problem is still counted as solved)' : i.kind === 'model' ? 'live sync' : 'historical'} · ${i.retryable ? 'recoverable automatically' : 'needs your action first'}` })),
      h('div', { class: 'row gap' }, h('span', { class: `badge ${CAT_BADGE[i.category] || 'badge-muted'}`, text: CAT_NAME[i.category] || i.category }),
        h('button', { class: 'btn btn-secondary btn-sm', text: 'Retry', onclick: async () => { if (i.kind === 'save') { await send(MSG.RETRY_SAVE, { id: i.id }); toast('Retrying GitHub save…'); loaders.failed(); } else { await send(MSG.RETRY_FAILED, { ids: [i.id] }); toast('Retrying…'); showTab('historical'); } } })))));
  };
  $('retryRecoverable').addEventListener('click', async () => { const r = await send(MSG.RETRY_FAILED, { mode: 'recoverable' }); toast(r.retried || r.modelOk ? 'Retrying recoverable items…' : 'No recoverable items.'); if (r.retried) showTab('historical'); else loaders.failed(); });
  $('retryAll').addEventListener('click', async () => { const r = await send(MSG.RETRY_FAILED, { mode: 'all' }); toast('Retrying all items…'); if (r.retried) showTab('historical'); else loaders.failed(); });
  $('clearFailed').addEventListener('click', async () => { if (confirm('Clear the failed list? The items stay un-synced.')) { await send(MSG.CLEAR_FAILED_ITEMS); loaders.failed(); } });

  /* ------------------------------ decisions ------------------------------ */
  async function resolveDecision(id, action) {
    try {
      const r = await send(MSG.RESOLVE_DECISION, { id, action });
      toast(r.errors && r.errors.length ? r.errors[0] : `Done (${r.resolved} resolved).`, !!(r.errors && r.errors.length));
    } catch (e) { toast(e.message, true); }
    loaders.decisions();
  }
  loaders.decisions = async function () {
    await refreshState();
    const items = await send(MSG.GET_PENDING_DECISIONS);
    const body = $('decisionsBody'); clear(body);
    if (!items.length) { body.append(h('p', { class: 'muted', text: 'No decisions pending.' })); return; }
    items.forEach((i) => body.append(h('div', { class: 'dec-item' },
      h('div', {}, h('strong', { text: `${i.number ? '#' + i.number + ' ' : ''}${i.title}` }), ' ', h('span', { class: 'muted', text: i.language }),
        h('div', { class: 'muted small mono', text: i.path }), h('div', { class: 'muted small', text: `New code: ${i.newCodeLines} lines · found ${fmtTime(i.createdAt)}` })),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn btn-primary btn-sm', text: 'Overwrite', onclick: () => resolveDecision(i.id, 'overwrite') }),
        h('button', { class: 'btn btn-secondary btn-sm', text: 'Keep GitHub', onclick: () => resolveDecision(i.id, 'keep') })))));
  };
  $('decOverwriteAll').addEventListener('click', () => { if (confirm('Overwrite every listed file on GitHub with the newest Accepted code?')) resolveDecision('all', 'overwrite'); });
  $('decKeepAll').addEventListener('click', () => resolveDecision('all', 'keep'));

  /* ------------------------------ repository ------------------------------ */
  let indexEntries = [];
  function renderIndex() {
    const q = $('indexFilter').value.trim().toLowerCase();
    const body = $('indexTable').querySelector('tbody'); clear(body);
    indexEntries.filter((e) => !q || `${e.number} ${e.title} ${e.slug} ${e.difficulty} ${e.languages.join(' ')}`.toLowerCase().includes(q))
      .forEach((e) => body.append(h('tr', {}, h('td', { text: e.number || '' }), h('td', { text: e.title }), h('td', { text: e.difficulty || '' }), h('td', { text: e.languages.join(', ') }))));
  }
  loaders.repository = async function () {
    const v = await send(MSG.GET_INDEX);
    indexEntries = v.entries; renderIndex();
  };
  $('indexFilter').addEventListener('input', renderIndex);

  $('coverageBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Checking…', async () => {
    showResult('toolResult', 'info', 'Reading your repository and LeetCode solved list…');
    const r = await send(MSG.VERIFY_COVERAGE);
    if (!r.ok) { $('coverageBox').hidden = true; return showResult('toolResult', 'error', r.message); }
    const c = r.result;
    showResult('toolResult', c.missing.length ? 'warn' : 'success',
      `LeetCode solved: ${c.leetcodeSolved} · listed: ${c.listed} · in your repository: ${c.inRepo} · missing: ${c.missing.length}`);
    const list = $('coverageList'); clear(list);
    c.missing.forEach((m) => list.append(h('span', { class: 'tag', text: `${m.number ? '#' + m.number + ' ' : ''}${m.title || m.slug}` })));
    $('coverageBox').hidden = !c.missing.length; $('syncMissingBtn').hidden = !c.missing.length;
    loaders.repository();
  }).catch((e) => showResult('toolResult', 'error', e.message)));

  $('syncMissingBtn').addEventListener('click', async () => { $('optDry').checked = false; $('optNew').checked = true; $('optReuse').checked = false; showTab('historical'); await startHistorical({ onlyNew: true, reuseDiscovery: false, dryRun: false }); });

  $('rebuildBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Reading repository…', async () => {
    const r = await send(MSG.REBUILD_INDEX);
    if (!r.ok) return showResult('toolResult', 'error', r.message);
    showResult('toolResult', r.result.truncated ? 'warn' : 'success', `Index rebuilt: ${r.result.problems} problem(s), ${r.result.files} solution file(s) (${r.result.added} newly discovered).${r.result.truncated ? ' The repository is very large; the listing was truncated by GitHub.' : ''}`);
    loaders.repository(); refreshState();
  }).catch((e) => showResult('toolResult', 'error', e.message)));

  $('regenBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Writing…', async () => {
    const r = await send(MSG.REGENERATE_READMES, { problemReadmes: $('regenProblem').checked });
    showResult('toolResult', r.ok ? 'success' : 'error', r.ok ? `Done. ${r.result.filesWritten} file(s) changed on GitHub for ${r.result.problems} problem(s).` : r.message);
  }).catch((e) => showResult('toolResult', 'error', e.message)));

  /* ------------------------------ diagnostics ------------------------------ */
  const DIAG_BADGE = { pass: ['PASS', 'badge-success'], warn: ['WARN', 'badge-warning'], fail: ['FAIL', 'badge-danger'], skip: ['SKIP', 'badge-muted'] };
  function renderDiagnostics(rep) {
    const list = $('diagList'); clear(list);
    const sum = $('diagSummary'); clear(sum);
    if (!rep) return;
    const fails = rep.checks.filter((c) => c.status === 'fail').length;
    const warns = rep.checks.filter((c) => c.status === 'warn').length;
    sum.append(h('div', { class: `result ${fails ? 'error' : warns ? 'warn' : 'success'}` },
      fails ? `${fails} check(s) failed - fix these first.` : warns ? `Everything essential works. ${warns} warning(s) - see below.` : 'All checks passed. You are ready to sync.', ` (${fmtTime(rep.at)})`));
    rep.checks.forEach((c) => {
      const [label, cls] = DIAG_BADGE[c.status] || ['?', 'badge-muted'];
      list.append(h('div', { class: 'diag' }, h('div', {}, h('span', { class: `badge ${cls}`, text: label })),
        h('div', {}, h('div', { class: 'd-title', text: c.title }), h('div', { class: 'd-detail', text: c.detail }), c.hint ? h('div', { class: 'd-hint', text: c.hint }) : null)));
    });
  }
  loaders.diagnostics = async function () {
    const rep = await chrome.storage.local.get(LGS.CONST.STORAGE_KEYS.DIAGNOSTICS);
    renderDiagnostics(rep[LGS.CONST.STORAGE_KEYS.DIAGNOSTICS]);
  };
  $('diagBtn').addEventListener('click', (e) => busy(e.currentTarget, 'Running checks…', async () => renderDiagnostics(await send(MSG.RUN_DIAGNOSTICS))).catch((err) => toast(err.message, true)));

  /* ------------------------------ settings ------------------------------ */
  const SPEC = [
    { group: 'Syncing' },
    { key: 'autoSync', type: 'bool', title: 'Save solved problems to GitHub automatically', desc: 'After YOU submit on LeetCode and LeetCode confirms the problem is solved (Accepted), the exact accepted code is saved to GitHub. The extension never submits, runs or clicks anything on LeetCode.' },
    { key: 'dailyGoal', type: 'number', title: 'Daily goal (problems)', desc: '0 = no goal. When set, Today\'s Progress shows a progress bar toward it.' },
    { key: 'showFloatingPanel', type: 'bool', title: 'Show the status panel on LeetCode', desc: 'A small read-only panel that shows your submission result and GitHub save state. It has no buttons that act on LeetCode.' },
    { key: 'duplicateHandling', type: 'select', title: 'When the file already exists on GitHub with different code', desc: 'Identical code is never rewritten, whatever you choose.',
      options: [['update', 'Update it with the newest Accepted code'], ['skip', 'Skip - keep the GitHub version'], ['ask', 'Ask me - collect in the Decisions tab']] },
    { key: 'notifications', type: 'bool', title: 'Desktop notifications', desc: 'Show a notification after a save, or when a submission was not accepted.' },
    { group: 'Repository output' },
    { key: 'generateProblemReadme', type: 'bool', title: 'Per-problem README', desc: 'Write README.md in each problem folder listing every language you solved it in.' },
    { key: 'updateRepoReadme', type: 'bool', title: 'Update the repository README', desc: 'Maintain a progress/solutions section between the LEETCODE-SYNC markers. Your own text elsewhere in README.md is never touched.' },
    { key: 'generateTopicIndex', type: 'bool', title: 'Topic index (TOPICS.md)', desc: 'Group your solutions by topic (Array, DP, Graph…).' },
    { group: 'Historical sync' },
    { key: 'historicalStrategy', type: 'select', title: 'Which Accepted submission to keep', desc: 'Per problem and language.', options: [['latest', 'The most recent Accepted submission'], ['first', 'The first Accepted submission']] },
    { key: 'discoverySource', type: 'select', title: 'Submission list source', desc: 'Auto tries LeetCode\'s REST endpoint and falls back to GraphQL. Pin one only if Diagnostics shows the other misbehaving.', options: [['auto', 'Auto (recommended)'], ['rest', 'REST only'], ['graphql', 'GraphQL only']] },
    { key: 'historicalPageSize', type: 'number', title: 'Page size', desc: 'Submissions requested per page (5-100). If LeetCode returns fewer, the extension adapts - nothing is skipped.' },
    { key: 'maxCandidatesPerProblem', type: 'number', title: 'Max submissions checked per problem', desc: 'Only matters when LeetCode gives no status in its list: how many recent submissions to verify one by one.' },
    { group: 'Pacing & safety' },
    { key: 'leetcodeRequestDelayMs', type: 'number', title: 'Delay between LeetCode requests (ms)', desc: 'Higher is gentler on LeetCode. Default 700.' },
    { key: 'githubWriteDelayMs', type: 'number', title: 'Delay between GitHub writes (ms)', desc: 'GitHub asks for at least 1 second between content writes. Default 1000.' },
    { group: 'Troubleshooting' },
    { key: 'debugLogging', type: 'bool', title: 'Debug logging', desc: 'Extra detail in the Logs tab. Tokens and source code are never logged.' }
  ];
  const fields = {};
  function buildSettingsForm() {
    const form = $('settingsForm'); clear(form);
    SPEC.forEach((s) => {
      if (s.group) { form.append(h('div', { class: 'setting-group', text: s.group })); return; }
      let input;
      if (s.type === 'bool') input = h('input', { type: 'checkbox' });
      else if (s.type === 'number') input = h('input', { type: 'number', min: '0' });
      else input = h('select', {}, s.options.map(([v, l]) => h('option', { value: v, text: l })));
      fields[s.key] = input;
      form.append(h('div', { class: 'setting' }, h('div', {}, h('div', { class: 's-title', text: s.title }), h('div', { class: 's-desc', text: s.desc })), input));
    });
  }
  function fillSettings() {
    const s = state.settings;
    SPEC.forEach((sp) => {
      if (!sp.key) return;
      if (sp.type === 'bool') fields[sp.key].checked = !!s[sp.key]; else fields[sp.key].value = s[sp.key];
    });
    const c = state.githubConfig;
    $('gOwner').value = c ? c.owner : ''; $('gRepo').value = c ? c.repo : ''; $('gBranch').value = c ? c.branch : 'main';
    $('gToken').value = ''; $('gToken').placeholder = c && c.hasToken ? '•••••••• saved - leave blank to keep' : 'github_pat_…';
  }
  loaders.settings = async function () { await refreshState(); fillSettings(); };

  $('gSave').addEventListener('click', (e) => busy(e.currentTarget, 'Saving…', async () => {
    try {
      await send(MSG.SAVE_GITHUB_CONFIG, { owner: $('gOwner').value, repo: $('gRepo').value, branch: $('gBranch').value || 'main', token: $('gToken').value });
      $('gToken').value = '';
      showResult('gResult', 'success', 'Saved. Use "Test connection" to verify it.');
      await refreshState(); fillSettings();
    } catch (err) { showResult('gResult', 'error', err.message); }
  }));
  $('gTest').addEventListener('click', (e) => busy(e.currentTarget, 'Testing…', async () => {
    try {
      const r = await send(MSG.TEST_GITHUB_CONNECTION, { owner: $('gOwner').value.trim(), repo: $('gRepo').value.trim(), branch: ($('gBranch').value || 'main').trim(), token: $('gToken').value });
      showResult('gResult', r.ok ? (r.warning ? 'warn' : 'success') : 'error', r.ok ? `✓ ${r.repository} @ ${r.branch} (${r.isPrivate ? 'private' : 'public'})${r.warning ? '\n⚠ ' + r.warning : ''}` : r.message);
    } catch (err) { showResult('gResult', 'error', err.message); }
  }));
  $('gClear').addEventListener('click', async () => {
    if (!confirm('Remove the GitHub token and repository settings from this browser?')) return;
    await send(MSG.CLEAR_GITHUB_CONFIG); await refreshState(); fillSettings(); showResult('gResult', 'success', 'Disconnected. The token was removed from this browser.');
  });
  $('sSave').addEventListener('click', (e) => busy(e.currentTarget, 'Saving…', async () => {
    const patch = {};
    SPEC.forEach((sp) => { if (!sp.key) return; patch[sp.key] = sp.type === 'bool' ? fields[sp.key].checked : sp.type === 'number' ? Number(fields[sp.key].value) : fields[sp.key].value; });
    try {
      const r = await send(MSG.SAVE_SETTINGS, patch);
      state.settings = r.settings; fillSettings();
      showResult('sResult', 'success', 'Preferences saved (values outside the allowed range were adjusted).');
    } catch (err) { showResult('sResult', 'error', err.message); }
  }));
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset all local data (statistics, activity, index, failed list, cached scans)? Nothing on GitHub or LeetCode is touched; stats can be re-imported.')) return;
    try { await send(MSG.RESET_LOCAL_DATA); showResult('resetResult', 'success', 'Local data reset.'); refreshState(); }
    catch (err) { showResult('resetResult', 'error', err.message); }
  });

  /* ------------------------------ logs ------------------------------ */
  loaders.logs = async function () {
    const logs = await send(MSG.GET_LOGS);
    $('logBox').textContent = logs.length ? logs.map((l) => `${l.time}  ${l.level.toUpperCase().padEnd(5)} [${l.ctx}] ${l.message}`).join('\n') : 'No log entries yet.';
  };
  $('logRefresh').addEventListener('click', () => loaders.logs());
  $('logCopy').addEventListener('click', async () => { await navigator.clipboard.writeText($('logBox').textContent); toast('Copied.'); });
  $('logClear').addEventListener('click', async () => { await send(MSG.CLEAR_LOGS); loaders.logs(); });

  /* ------------------------------ boot ------------------------------ */
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  window.addEventListener('hashchange', () => { const h0 = parseHash(); showTab(h0.name, h0.params); });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.HISTORICAL_PROGRESS_UPDATED) { renderProgress(msg.payload); if (msg.payload.state === 'completed') loadReport(); }
    if (msg.type === MSG.SYNC_HISTORY_UPDATED) refreshState();
  });
  // Live dashboard: any change to activity, problems, live status or the save queue refreshes the numbers.
  let liveTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const K = LGS.CONST.STORAGE_KEYS;
    if (![K.EVENTS, K.PROBLEMS, K.LIVE_SUBMISSION, K.SAVE_QUEUE, K.STATS_META, K.LEETCODE_STATS].some((k) => changes[k])) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (!$('progBody').closest('.view').hidden) loaders.progress().catch(() => {}); }, 300);
  });
  setInterval(() => { if (!document.hidden && !$('progBody').closest('.view').hidden) loaders.progress().catch(() => {}); }, 60000);
  // Safety net in case a broadcast was missed (worker restarted).
  setInterval(() => {
    if (document.hidden) return;
    if (lastProgress && ['discovering', 'running', 'waiting'].includes(lastProgress.state)) send(MSG.GET_HISTORICAL_PROGRESS).then(renderProgress).catch(() => {});
  }, 4000);

  buildSettingsForm();
  { const h0 = parseHash(); showTab(h0.name || 'progress', h0.params); }
  refreshState().catch((e) => toast(e.message, true));
})();
