/**
 * components.js  (src/ui/)
 *
 * Dashboard building blocks shared by the popup and the Control Center.
 * Every function takes the stats SNAPSHOT computed by the background worker
 * (src/analytics/stats.js) and returns a DOM node. All text is inserted with
 * textContent - titles from LeetCode can never inject markup.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const NS = 'http://www.w3.org/2000/svg';

  const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  // [tag, attrs] lists, built with createElementNS (no innerHTML)
  const P = (d) => ['path', { d }];
  const ICONS = {
    flame: [P('M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z')],
    trophy: [P('M8 4h8v5a4 4 0 0 1-8 0V4z'), P('M8 6H5a2 2 0 0 0 0 4h3M16 6h3a2 2 0 0 1 0 4h-3'), P('M12 13v4M8.5 20h7')],
    check: [P('M5 12.5l4.5 4.5L19 7.5')],
    x: [P('M6 6l12 12M18 6L6 18')],
    alert: [P('M12 3l10 18H2L12 3z'), P('M12 10v5M12 18v.5')],
    clock: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 7v5l3 2')],
    bolt: [P('M13 2L4 14h7l-1 8 9-12h-7l1-8z')],
    brain: [P('M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 5 2V4a3 3 0 0 0-2 0z'), P('M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-5 2V4a3 3 0 0 1 2 0z')],
    code: [P('M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16')],
    chart: [P('M4 20V10M10 20V4M16 20v-7M22 20H2')],
    refresh: [P('M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4')],
    ext: [P('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')],
    cog: [['circle', { cx: 12, cy: 12, r: 3 }], P('M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1')],
    spinner: [['circle', { cx: 12, cy: 12, r: 9, 'stroke-dasharray': '38 20' }]]
  };

  function icon(name, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico ' + (cls || ''));
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    (ICONS[name] || []).forEach(([tag, attrs]) => {
      const c = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach((k) => c.setAttribute(k, attrs[k]));
      s.append(c);
    });
    return s;
  }

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

  /* ---------- animated numbers ---------- */
  const prev = {};
  const reduced = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function num(key, value, suffix) {
    const span = h('span', { text: String(value) + (suffix || '') });
    const from = prev[key];
    prev[key] = value;
    if (typeof value === 'number' && typeof from === 'number' && from !== value && !reduced()) {
      const start = performance.now(); const dur = 500;
      span.classList.add('pop');
      const tick = (t) => {
        const p = Math.min(1, (t - start) / dur); const e = 1 - Math.pow(1 - p, 3);
        span.textContent = Math.round(from + (value - from) * e) + (suffix || '');
        if (p < 1) requestAnimationFrame(tick);
      };
      span.textContent = from + (suffix || '');
      requestAnimationFrame(tick);
    }
    return span;
  }

  function relTime(sec) {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (d < 60) return 'Just now';
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    const t = new Date(sec * 1000); const now = new Date();
    const dayDiff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
    if (dayDiff === 0) return `${Math.floor(d / 3600)} hour${Math.floor(d / 3600) === 1 ? '' : 's'} ago`;
    if (dayDiff === 1) return 'Yesterday';
    if (dayDiff < 7) return `${dayDiff} days ago`;
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const title = (iconName, text, right) => h('div', { class: 'u-title' }, icon(iconName), h('span', { text }), h('span', { class: 'grow' }), right || null);
  const pct = (a, b) => (b ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 0);
  function bar(percent, cls) {
    const i = h('i'); const b = h('div', { class: `bar ${cls || ''}` }, i);
    requestAnimationFrame(() => { i.style.width = `${percent}%`; });
    return b;
  }

  /* ---------- sections ---------- */
  function hero(snap) {
    return h('div', { class: 'u-card hero fadein' },
      h('div', { class: 'hero-num' }, num('solved', snap.solved)),
      h('div', { class: 'hero-label', text: 'Problems Solved' }),
      h('div', { class: 'hero-today' + (snap.newToday ? '' : ' zero') }, `+${snap.newToday} today`),
      h('div', { class: 'hero-sub', text: `${snap.attempted} attempted${snap.leetcodeSolved != null && snap.leetcodeSolved !== snap.solved ? ` · LeetCode reports ${snap.leetcodeSolved}` : ''}` }));
  }

  function streakTiles(snap) {
    const st = snap.streak;
    return h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'k' }, icon('flame', 'flame'), 'Current streak'),
        h('div', { class: 'v' }, num('streak', st.current), ' ', h('small', { class: 'muted', text: st.current === 1 ? 'day' : 'days' })),
        h('div', { class: 's', text: st.activeToday ? 'Solved today ✓' : (st.current ? 'Solve one today to keep it' : 'Start one today') })),
      h('div', { class: 'tile' }, h('div', { class: 'k' }, icon('trophy', 'trophy'), 'Longest streak'),
        h('div', { class: 'v' }, num('longest', st.longest), ' ', h('small', { class: 'muted', text: st.longest === 1 ? 'day' : 'days' })),
        h('div', { class: 's', text: 'Personal best' })));
  }

  function statTiles(snap) {
    const d = snap.difficulty; const a = snap.acceptance;
    const tile = (cls, label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'k' }, h('i', { class: cls }), label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's', text: sub }) : null);
    return h('div', { class: 'tiles' },
      tile('dot-e', 'Easy', num('easy', d.Easy)), tile('dot-m', 'Medium', num('medium', d.Medium)),
      tile('dot-h', 'Hard', num('hard', d.Hard)),
      h('div', { class: 'tile' }, h('div', { class: 'k' }, icon('check', ''), 'Acceptance'),
        h('div', { class: 'v' }, a.rate == null ? '—' : num('acc', a.rate, '%')), h('div', { class: 's', text: a.total ? `${a.accepted} of ${a.total} submissions` : 'No data yet' })));
  }

  function difficulty(snap) {
    const d = snap.difficulty; const max = Math.max(d.Easy, d.Medium, d.Hard, 1);
    const row = (label, cls, v) => h('div', { class: 'rowline' }, h('span', { class: `diff-${label}`, text: label }), bar(pct(v, max), cls), h('span', { class: 'n' }, num('d' + label, v)));
    return h('div', { class: 'u-card' }, title('chart', 'Difficulty'), row('Easy', 'e', d.Easy), row('Medium', 'm', d.Medium), row('Hard', 'h', d.Hard));
  }

  function today(snap) {
    const t = snap.today; const hasGoal = t.goal > 0;
    const body = [];
    if (hasGoal) {
      body.push(h('div', { class: 'big-frac' }, num('todaySolved', t.solved), h('small', { text: ` / ${t.goal}` })));
      body.push(bar(pct(t.solved, t.goal), t.solved >= t.goal ? 'ok' : ''));
    } else {
      body.push(h('div', { class: 'big-frac' }, num('todaySolved', t.solved), h('small', { text: ' solved' })));
    }
    body.push(h('div', { class: 'today-nums' }, h('span', {}, h('b', { text: String(t.solved) }), ' solved'), h('span', {}, h('b', { text: String(t.submissions) }), ' submissions'),
      h('span', {}, h('b', { text: String(t.failed) }), ' not accepted')));
    return h('div', { class: 'u-card' }, title('bolt', "Today's Progress"), body);
  }

  /** The current / most recent submission (LeetCode state and GitHub state kept separate). */
  function live(snap, handlers) {
    const l = snap.live; if (!l) return null;
    const age = Date.now() - (l.updatedAt || 0);
    if (!(age < 15 * 60 * 1000)) return null;
    const lc = l.lc; let cls = 'wait'; let ic = 'spinner'; let head = 'Checking submission…';
    if (lc !== 'checking') {
      if (lc === 'Accepted') { cls = 'ok'; ic = 'check'; head = 'Accepted'; }
      else if (lc === 'Wrong Answer') { cls = 'bad'; ic = 'x'; head = 'Wrong Answer'; }
      else if (lc === 'Time Limit Exceeded') { cls = 'warn'; ic = 'clock'; head = 'Time Limit Exceeded'; }
      else { cls = 'warn'; ic = 'alert'; head = lc || 'Finished'; }
    } else if (age > 3 * 60 * 1000) return null;
    const meta = [l.difficulty, (l.topics || [])[0], l.language].filter(Boolean).join(' · ');
    const gh = { pending: 'GitHub save pending…', saving: 'Saving to GitHub…', saved: 'Saved to GitHub', failed: 'GitHub save failed' }[l.gh];
    return h('div', { class: `u-card live ${cls} enter` }, h('div', { class: 'badge-ic' }, icon(ic)),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 't1', text: head }), h('div', { class: 't2', text: [l.title || l.slug, meta].filter(Boolean).join(' — ') }),
        lc === 'Accepted' && gh ? h('div', { class: 'gh' }, h('i', { class: 'gh-dot gh-' + l.gh }), gh, l.gh === 'failed' && handlers && handlers.retrySave ? h('button', { class: 'u-link', style: 'margin-left:8px', text: 'Retry', onclick: handlers.retrySave }) : null) : null));
  }

  function recent(snap, limit, onOpen, onViewAll) {
    const items = snap.recent.slice(0, limit);
    const list = h('div', { class: 'list' });
    if (!items.length) list.append(h('div', { class: 'empty' }, h('b', { text: 'No solved problems yet' }), 'Accepted solutions will appear here automatically.'));
    items.forEach((r) => {
      const meta = [r.difficulty && h('span', { class: `diff-${r.difficulty}`, text: r.difficulty }), r.topics[0] && ` · ${r.topics[0]}`, ` · ${r.lang}`];
      list.append(h('div', { class: 'item', title: [r.runtime && `Runtime ${r.runtime}`, r.memory && `Memory ${r.memory}`].filter(Boolean).join(' · ') || r.title, onclick: () => onOpen && onOpen(r.slug) },
        h('div', { class: 'ic' }, icon('check')),
        h('div', { class: 'mid' }, h('div', { class: 't', text: `${r.number ? '#' + r.number + ' ' : ''}${r.title}` }), h('div', { class: 'm' }, ...meta)),
        h('div', { class: 'r' }, r.gh && r.gh !== 'saved' && r.gh !== 'off' ? h('i', { class: 'gh-dot gh-' + r.gh, title: r.gh === 'failed' ? 'GitHub save failed' : 'Saving to GitHub' }) : null, relTime(r.ts))));
    });
    return h('div', { class: 'u-card' }, title('check', 'Recent Activity', onViewAll && snap.recent.length > limit ? h('a', { text: 'View all', onclick: onViewAll }) : null), list);
  }

  function topics(snap, limit, onTopic, heading) {
    const list = snap.topics.slice(0, limit); const max = list.length ? list[0].count : 1;
    const box = h('div', {});
    if (!list.length) box.append(h('div', { class: 'empty' }, 'Topics appear as you solve problems.'));
    list.forEach((t, i) => box.append(h('div', { class: 'topic', onclick: () => onTopic && onTopic(t.name), title: `Show ${t.name} problems` },
      h('span', { class: 'rank', text: String(i + 1) }), h('span', { class: 'name', text: t.name }), h('span', { class: 'cnt' }, num('t' + t.name, t.count)), bar(pct(t.count, max)))));
    return h('div', { class: 'u-card' }, title('brain', heading || 'Top Topics'), box);
  }

  function languages(snap) {
    const list = snap.languages.slice(0, 6); const max = list.length ? list[0].count : 1;
    const box = h('div', {});
    if (!list.length) box.append(h('div', { class: 'empty' }, 'Languages appear after your first accepted solution.'));
    list.forEach((l) => box.append(h('div', { class: 'rowline' }, h('span', { text: l.name }), bar(pct(l.count, max)), h('span', { class: 'n' }, num('l' + l.name, l.count)))));
    return h('div', { class: 'u-card' }, title('code', 'Languages'), box);
  }

  function heatmap(snap) {
    const level = (c) => (c <= 0 ? '' : c === 1 ? 'l1' : c === 2 ? 'l2' : c <= 4 ? 'l3' : 'l4');
    const grid = h('div', { class: 'heat' });
    snap.heatmap.forEach((c) => grid.append(h('div', { class: `hc ${c.future ? 'future' : level(c.count)}`, title: c.future ? '' : `${c.date}: ${c.count} solved, ${c.submissions} submissions` })));
    const legend = h('div', { class: 'legend' }, 'Less', ...['', 'l1', 'l2', 'l3', 'l4'].map((l) => h('div', { class: `hc ${l}` })), 'More');
    return h('div', { class: 'u-card' }, title('chart', `Activity · last ${snap.heatmap.length / 7} weeks`), grid, legend);
  }

  function week(snap) {
    const max = Math.max(1, ...snap.weekBars.map((b) => b.count));
    const bars = h('div', { class: 'weekbars' });
    snap.weekBars.forEach((b) => {
      const i = h('i'); i.style.height = `${b.count ? 12 + Math.round((b.count / max) * 48) : 4}px`;
      bars.append(h('div', { class: `wb ${b.count ? 'on' : ''} ${b.today ? 'today' : ''}`, title: `${b.label}: ${b.count} solved` }, i, h('span', { text: b.label })));
    });
    const w = snap.week;
    return h('div', { class: 'u-card' }, title('chart', 'This Week'), bars,
      h('div', { class: 'kv', style: 'margin-top:12px' },
        h('div', {}, h('span', { text: 'Solved' }), h('b', { text: String(w.solved) })), h('div', {}, h('span', { text: 'Submissions' }), h('b', { text: String(w.submissions) })),
        h('div', {}, h('span', { text: 'Acceptance' }), h('b', { text: w.acceptance == null ? '—' : w.acceptance + '%' })), h('div', {}, h('span', { text: 'Best day' }), h('b', { text: w.bestDay || '—' }))));
  }

  function month(snap) {
    const m = snap.month;
    return h('div', { class: 'u-card' }, title('chart', 'This Month'),
      h('div', { class: 'kv' }, h('div', {}, h('span', { text: 'Solved' }), h('b', { text: String(m.solved) })), h('div', {}, h('span', { text: 'Submissions' }), h('b', { text: String(m.submissions) })),
        h('div', {}, h('span', { text: 'Acceptance' }), h('b', { text: m.acceptance == null ? '—' : m.acceptance + '%' }))));
  }


  /* ---------- compact variants (popup) ---------- */
  function heroCompact(snap) {
    return h('div', { class: 'u-card hero-c fadein' },
      h('div', { class: 'hero-num' }, num('solved', snap.solved)),
      h('div', { class: 'hero-c-r' }, h('div', { class: 'hero-label', text: 'Problems solved' }),
        h('div', { class: 'hero-today' + (snap.newToday ? '' : ' zero'), text: `+${snap.newToday} today` })));
  }
  function diffRow(snap) {
    const d = snap.difficulty;
    const t = (cls, label, v, key) => h('div', { class: 'mini' }, h('div', { class: 'k' }, h('i', { class: cls }), label), h('div', { class: 'v' }, num(key, v)));
    return h('div', { class: 'minis' }, t('dot-e', 'Easy', d.Easy, 'easy'), t('dot-m', 'Medium', d.Medium, 'medium'), t('dot-h', 'Hard', d.Hard, 'hard'));
  }
  function todayCompact(snap) {
    const t = snap.today; const goal = t.goal > 0;
    const line = h('div', { class: 'today-c' }, icon('bolt'), h('span', { class: 'lbl', text: 'Today' }),
      h('span', {}, h('b', {}, num('todaySolved', t.solved)), goal ? ` / ${t.goal}` : '', ' solved'),
      h('span', { class: 'muted', text: `· ${t.submissions} submission${t.submissions === 1 ? '' : 's'}` }));
    return h('div', { class: 'u-card tc' }, line, goal ? bar(pct(t.solved, t.goal), t.solved >= t.goal ? 'ok' : '') : null);
  }
  function recentCompact(snap, limit, onOpen, onViewAll) {
    const items = snap.recent.slice(0, limit);
    const list = h('div', { class: 'list' });
    if (!items.length) list.append(h('div', { class: 'empty small', text: 'Solved problems appear here automatically.' }));
    items.forEach((r) => list.append(h('div', { class: 'item c', onclick: () => onOpen && onOpen(r.slug) },
      h('div', { class: 'ic' }, icon('check')),
      h('div', { class: 'mid' }, h('div', { class: 't', text: `${r.number ? '#' + r.number + ' ' : ''}${r.title}` }),
        h('div', { class: 'm' }, r.difficulty ? h('span', { class: `diff-${r.difficulty}`, text: r.difficulty }) : '', ` · ${r.lang}`)),
      h('div', { class: 'r' }, r.gh && r.gh !== 'saved' && r.gh !== 'off' ? h('i', { class: 'gh-dot gh-' + r.gh, title: r.gh === 'failed' ? 'GitHub save failed' : 'Saving to GitHub' }) : null, relTime(r.ts)))));
    return h('div', { class: 'u-card rc' }, h('div', { class: 'u-title' }, h('span', { text: 'Recent' }), h('span', { class: 'grow' }), onViewAll ? h('a', { text: 'More', onclick: onViewAll }) : null), list);
  }

  function emptyState(onImport, importing) {
    const btn = h('button', { class: 'btn-grad', text: importing ? 'Importing…' : 'Import my LeetCode history', onclick: onImport });
    btn.disabled = !!importing;
    return h('div', { class: 'u-card empty fadein' }, h('b', { text: 'Welcome to LeetHub' }),
      'Solve a problem and this updates by itself. Already solved a lot? Import your history once (keep a logged-in LeetCode tab open).', h('div', { style: 'margin-top:12px' }, btn));
  }

  LGS.ui = { icon, h, clear, num, relTime, heroCompact, diffRow, todayCompact, recentCompact, hero, streakTiles, statTiles, difficulty, today, live, recent, topics, languages, heatmap, week, month, emptyState, bar, title };
})(window);
