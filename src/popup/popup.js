(function () {
  const { MSG, STORAGE_KEYS } = LGS.CONST;
  const U = LGS.ui;
  const $ = (id) => document.getElementById(id);
  let snap = null; let state = null; let importing = false; let timer = null;

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || r.ok === false) return reject(new Error((r && r.error) || 'Request failed'));
        resolve(r.data);
      });
    });
  }
  const openProblem = (slug) => chrome.tabs.create({ url: `https://leetcode.com/problems/${slug}/` });
  const openDash = (tab, topic) => send(MSG.OPEN_DASHBOARD, { tab: tab || 'progress', topic }).then(() => window.close());

  async function doImport() {
    importing = true; render();
    try { await send(MSG.REFRESH_STATS, { full: true }); } catch (e) { /* shown by the empty state again */ }
    importing = false; await load();
  }

  function render() {
    if (!snap) return;
    const st = snap.streak;
    const chip = $('streakChip');
    chip.hidden = false; chip.className = 'streak-chip' + (st.current ? '' : ' cold'); U.clear(chip);
    chip.append(U.icon('flame'), `${st.current} day streak`);

    const c = U.clear($('content'));
    const liveCard = U.live(snap, { retrySave: () => send(MSG.RETRY_SAVE, { id: 'all' }).then(load) });
    if (liveCard) c.append(liveCard);
    c.append(U.heroCompact(snap));
    if (!snap.hasData) c.append(U.emptyState(doImport, importing));
    c.append(U.diffRow(snap), U.todayCompact(snap), U.recentCompact(snap, 3, openProblem, () => openDash('progress')));

    const al = U.clear($('alerts'));
    if (state) {
      if (state.failedSaves) al.append(U.h('div', { class: 'alert bad' }, `${state.failedSaves} GitHub save${state.failedSaves > 1 ? 's' : ''} failed`, U.h('button', { text: 'Retry', onclick: () => send(MSG.RETRY_SAVE, { id: 'all' }).then(load) })));
    }
    $('refreshBtn').title = snap.lastRefreshAt ? `Refresh from LeetCode - last updated ${U.relTime(Math.floor(snap.lastRefreshAt / 1000))}` : 'Refresh from LeetCode';
  }

  function renderFooter() {
    const g = U.clear($('ghStatus'));
    const cfg = state && state.githubConfig;
    if (cfg && cfg.hasToken) {
      const busy = state.pendingSaves ? ` · ${state.pendingSaves} saving` : '';
      g.append(U.h('i', { class: 'gh-dot ' + (state.failedSaves ? 'gh-failed' : state.pendingSaves ? 'gh-pending' : 'gh-saved') }), `GitHub connected${busy}`);
      g.title = `${cfg.owner}/${cfg.repo}`;
    } else {
      g.append(U.h('i', { class: 'gh-dot' }), 'GitHub not connected');
    }
    g.onclick = () => openDash('settings');
  }

  async function load() {
    try {
      [snap, state] = await Promise.all([send(MSG.GET_STATS), send(MSG.GET_STATE)]);
      render(); renderFooter();
    } catch (e) {
      U.clear($('content')).append(U.h('div', { class: 'u-card empty' }, U.h('b', { text: 'Could not load' }), e.message));
    }
  }

  $('refreshBtn').append(U.icon('refresh'));
  $('openSettings').append(U.icon('cog'));
  $('refreshBtn').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.classList.add('spin');
    try { await send(MSG.REFRESH_STATS, {}); } catch (err) { /* needs a LeetCode tab; cached data stays */ }
    b.classList.remove('spin'); load();
  });
  $('openDash').addEventListener('click', () => openDash('progress'));
  $('openSettings').addEventListener('click', () => openDash('settings'));

  // Live updates: any change to activity / problems / live status / save queue re-renders.
  let debounce = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = [STORAGE_KEYS.EVENTS, STORAGE_KEYS.PROBLEMS, STORAGE_KEYS.LIVE_SUBMISSION, STORAGE_KEYS.SAVE_QUEUE, STORAGE_KEYS.SETTINGS, STORAGE_KEYS.GITHUB_CONFIG, STORAGE_KEYS.STATS_META];
    if (!keys.some((k) => changes[k])) return;
    clearTimeout(debounce); debounce = setTimeout(load, 250);
  });
  timer = setInterval(() => { if (!document.hidden) load(); }, 30000); // keeps "5 min ago" labels and day rollover right

  load();
})();
