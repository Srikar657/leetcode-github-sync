/**
 * widget.js  (src/content/)
 *
 * A small floating status panel on LeetCode problem pages:
 *   - live submission status ("Checking…", Accepted, Wrong Answer, …)
 *   - GitHub save state, shown as a quiet secondary line
 *   - it is READ-ONLY: it has no buttons that act on LeetCode, and it never
 *     touches LeetCode's Submit/Run buttons. You submit; this just reports.
 *
 * It lives in a Shadow DOM so LeetCode's CSS cannot affect it and it cannot
 * affect LeetCode. All text is set with textContent (no innerHTML).
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { MSG, STORAGE_KEYS, LEETCODE_STATUS } = LGS.CONST;

  const CSS = `
  :host { all: initial; }
  .card { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; width: 272px; box-sizing: border-box;
    font: 13px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #e8eaf0;
    background: #111318; border: 1px solid #262b36; border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,.45); overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; cursor: pointer; user-select: none; }
  .head img { width: 20px; height: 20px; border-radius: 5px; }
  .brand { font-weight: 700; flex: 1; letter-spacing: .01em; }
  .chev { color: #8b93a3; font-size: 11px; }
  .body { padding: 2px 12px 12px; display: block; }
  .collapsed .body { display: none; }
  .row { display: flex; align-items: center; gap: 9px; }
  .ico { width: 22px; height: 22px; flex: none; }
  .t1 { font-weight: 600; } .t2 { color: #8b93a3; font-size: 12px; }
  .ok { color: #34d399; } .bad { color: #f87171; } .warn { color: #fbbf24; } .wait { color: #8ea2ff; }
  .gh { margin-top: 8px; padding-top: 8px; border-top: 1px solid #20242e; color: #8b93a3; font-size: 12px; display: flex; gap: 6px; align-items: center; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #8b93a3; display: inline-block; }
  .dot.saved { background: #34d399; } .dot.saving, .dot.pending { background: #8ea2ff; animation: pulse 1s infinite; } .dot.failed { background: #f87171; }
  @keyframes pulse { 50% { opacity: .35; } }
  .link { background: none; border: 0; color: #8b93a3; font: inherit; font-size: 11.5px; cursor: pointer; padding: 6px 0 0; text-decoration: underline; }
  .spin { animation: spin 1s linear infinite; transform-origin: 50% 50%; } @keyframes spin { to { transform: rotate(360deg); } }
  .pop { animation: pop .35s ease-out; } @keyframes pop { 0% { transform: scale(.7); opacity: 0; } 70% { transform: scale(1.12); } 100% { transform: scale(1); opacity: 1; } }
  `;

  // Icons as plain data -> built with createElementNS (no innerHTML: safe under Trusted Types).
  const S = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const circle = ['circle', Object.assign({ cx: 12, cy: 12, r: 10 }, S)];
  const SVG = {
    check: [circle, ['path', Object.assign({ d: 'M7.5 12.5l3 3 6-7' }, S, { 'stroke-width': '2.2' })]],
    x: [circle, ['path', Object.assign({ d: 'M8.5 8.5l7 7M15.5 8.5l-7 7' }, S, { 'stroke-width': '2.2' })]],
    alert: [['path', Object.assign({ d: 'M12 3l10 18H2L12 3z' }, S)], ['path', Object.assign({ d: 'M12 10v5M12 18v.5' }, S, { 'stroke-width': '2.2' })]],
    clock: [circle, ['path', Object.assign({ d: 'M12 7v5l3 2' }, S, { 'stroke-width': '2.2' })]],
    spin: [['circle', Object.assign({ cx: 12, cy: 12, r: 9, 'stroke-dasharray': '40 20' }, S, { 'stroke-width': '2.5' })]],
    idle: [['path', Object.assign({ d: 'M8 5l11 7-11 7V5z' }, S)]]
  };

  const STATUS_UI = {
    [LEETCODE_STATUS.ACCEPTED]: { icon: 'check', cls: 'ok', text: 'Accepted' },
    [LEETCODE_STATUS.WRONG_ANSWER]: { icon: 'x', cls: 'bad', text: 'Wrong Answer' },
    [LEETCODE_STATUS.RUNTIME_ERROR]: { icon: 'alert', cls: 'warn', text: 'Runtime Error' },
    [LEETCODE_STATUS.TIME_LIMIT_EXCEEDED]: { icon: 'clock', cls: 'warn', text: 'Time Limit Exceeded' },
    [LEETCODE_STATUS.MEMORY_LIMIT_EXCEEDED]: { icon: 'alert', cls: 'warn', text: 'Memory Limit Exceeded' },
    [LEETCODE_STATUS.COMPILE_ERROR]: { icon: 'alert', cls: 'warn', text: 'Compile Error' },
    [LEETCODE_STATUS.OUTPUT_LIMIT_EXCEEDED]: { icon: 'alert', cls: 'warn', text: 'Output Limit Exceeded' },
    [LEETCODE_STATUS.UNKNOWN_ERROR]: { icon: 'alert', cls: 'warn', text: 'Result unclear' }
  };
  const GH_TEXT = { saved: 'Saved to GitHub', saving: 'Saving to GitHub…', pending: 'GitHub save pending - retrying', failed: 'GitHub save failed - open LeetHub to retry', off: '' };

  let host = null; let root = null; let els = null;
  let settings = null; let live = null; let collapsed = false; let lastSlug = null; let lastStatusKey = null;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function svg(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico ' + (cls || ''));
    SVG[name].forEach(([tag, attrs]) => {
      const child = document.createElementNS(ns, tag);
      Object.keys(attrs).forEach((k) => child.setAttribute(k, attrs[k]));
      s.append(child);
    });
    return s;
  }

  function build() {
    host = document.createElement('div');
    host.id = 'leethub-panel';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = CSS; root.append(style);

    const card = el('div', 'card');
    const head = el('div', 'head');
    const logo = document.createElement('img'); logo.alt = ''; logo.src = chrome.runtime.getURL('icons/icon48.png');
    const brand = el('div', 'brand', 'LeetHub'); const chev = el('div', 'chev', '▾');
    head.append(logo, brand, chev);
    const body = el('div', 'body');
    card.append(head, body);
    root.append(card);

    head.addEventListener('click', () => { collapsed = !collapsed; LGS.storage.setKey('widgetCollapsed', collapsed).catch(() => {}); render(); });
    els = { card, body, chev };
    document.documentElement.append(host);
  }

  function currentView() { return LGS.content.observer.view; }

  function render() {
    if (!els) return;
    const slug = LGS.leetcode.parser.getSlugFromUrl();
    const visible = !!slug && settings && settings.showFloatingPanel;
    host.style.display = visible ? '' : 'none';
    if (!visible) return;

    els.card.classList.toggle('collapsed', collapsed);
    els.chev.textContent = collapsed ? '▴' : '▾';
    const v = currentView();
    const mine = v.slug === slug && v.phase !== 'idle';

    const body = els.body; while (body.firstChild) body.removeChild(body.firstChild);

    // ---- status ----
    const row = el('div', 'row');
    if (!mine) {
      row.append(svg('idle', 'wait'));
      const t = el('div'); t.append(el('div', 't1', 'Ready to track'), el('div', 't2', 'Watching - submit on LeetCode as usual'));
      row.append(t);
    } else if (v.phase === 'checking') {
      row.append(svg('spin', 'wait spin'));
      const t = el('div'); t.append(el('div', 't1 wait', 'Checking submission…'), el('div', 't2', v.title || slug));
      row.append(t);
    } else if (v.phase === 'error') {
      row.append(svg('alert', 'warn'));
      const t = el('div'); t.append(el('div', 't1 warn', 'Could not track this submission'), el('div', 't2', v.error || ''));
      row.append(t);
    } else {
      const ui = STATUS_UI[v.status] || { icon: 'alert', cls: 'warn', text: v.status || 'Finished' };
      const key = v.submissionId + ':' + v.status;
      const icon = svg(ui.icon, ui.cls + (key !== lastStatusKey ? ' pop' : ''));
      lastStatusKey = key;
      row.append(icon);
      const t = el('div');
      t.append(el('div', 't1 ' + ui.cls, ui.text));
      const meta = [v.title, [v.difficulty, (v.topics || [])[0]].filter(Boolean).join(' · '), v.language].filter(Boolean);
      meta.forEach((m) => t.append(el('div', 't2', m)));
      if (v.status === LEETCODE_STATUS.ACCEPTED && (v.runtime || v.memory)) t.append(el('div', 't2', [v.runtime, v.memory].filter(Boolean).join(' · ')));
      row.append(t);
    }
    body.append(row);

    // ---- GitHub (quiet, only after Accepted) ----
    if (mine && v.phase === 'done' && v.status === LEETCODE_STATUS.ACCEPTED && live && String(live.id) === String(v.submissionId) && GH_TEXT[live.gh]) {
      const gh = el('div', 'gh'); gh.append(el('span', 'dot ' + live.gh), el('span', '', GH_TEXT[live.gh]));
      body.append(gh);
    }

    const link = el('button', 'link', 'Open dashboard');
    link.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: MSG.OPEN_DASHBOARD, payload: { tab: 'progress' } }); } catch (e) { /* ignore */ } });
    body.append(link);
  }

  async function loadSettings() {
    settings = await LGS.storage.getSettings();
    live = await LGS.storage.getKey(STORAGE_KEYS.LIVE_SUBMISSION, null);
    collapsed = !!(await LGS.storage.getKey('widgetCollapsed', false));
  }

  async function init() {
    if (document.getElementById('leethub-panel')) return;
    await loadSettings();
    build();
    render();
    LGS.content.observer.onChange(() => render());
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[STORAGE_KEYS.SETTINGS]) { LGS.storage.getSettings().then((s) => { settings = s; render(); }); }
        if (changes[STORAGE_KEYS.LIVE_SUBMISSION]) { live = changes[STORAGE_KEYS.LIVE_SUBMISSION].newValue || null; render(); }
      });
    } catch (e) { /* ignore */ }
    // LeetCode is a single-page app: follow navigation between problems.
    setInterval(() => {
      const slug = LGS.leetcode.parser.getSlugFromUrl();
      if (slug !== lastSlug) { lastSlug = slug; render(); }
    }, 1000);
  }

  LGS.content = LGS.content || {};
  LGS.content.widget = { init, render };
})(typeof self !== 'undefined' ? self : window);
