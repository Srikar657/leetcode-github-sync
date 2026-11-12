/**
 * stats.js  (src/analytics/)
 *
 * PURE statistics engine: events + solved-problem map in, dashboard
 * snapshot out. No chrome.* and no network, so it is trivially testable.
 * Every number the dashboard shows is computed here from real activity;
 * nothing is hard-coded or estimated.
 *
 * Definitions (documented because dashboards are only trustworthy when
 * their numbers are well defined):
 *
 *  - SOLVED problem   : a problem with at least one Accepted submission
 *                       (or listed as solved by LeetCode itself).
 *  - ACTIVE day       : a local calendar day with >= 1 Accepted submission.
 *  - CURRENT streak   : consecutive active days ending today - or ending
 *                       YESTERDAY if today has no accepted submission yet
 *                       (a streak is not broken until a full day is missed).
 *  - LONGEST streak   : longest run of consecutive active days ever.
 *  - solved today     : DISTINCT problems accepted today.
 *  - new today (+N)   : problems whose FIRST acceptance is today
 *                       (re-solving an old problem does not raise the total).
 *  - acceptance rate  : accepted submissions / submissions whose result is
 *                       known. Failed submissions never count as solved.
 *  - week             : Monday-Sunday of the current local week.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const pad = (n) => String(n).padStart(2, '0');
  function dayKey(sec) {
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function keyToNum(key) {
    const [y, m, d] = key.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function numToKey(n) {
    const d = new Date(n * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  /** Monday = 0 … Sunday = 6, for a day number. */
  function weekdayOfNum(n) { return (new Date(n * 86400000).getUTCDay() + 6) % 7; }

  function statsLanguage(label) {
    const l = String(label || 'Unknown');
    return l === 'Python3' ? 'Python' : l;
  }

  function streaks(activeKeys, todayKey) {
    const nums = Array.from(new Set(Array.from(activeKeys).map(keyToNum))).sort((a, b) => a - b);
    if (!nums.length) return { current: 0, longest: 0, activeToday: false };
    const set = new Set(nums);
    const today = keyToNum(todayKey);
    const activeToday = set.has(today);
    let cursor = activeToday ? today : today - 1;
    let current = 0;
    while (set.has(cursor)) { current++; cursor--; }
    let longest = 1; let run = 1;
    for (let i = 1; i < nums.length; i++) {
      run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    return { current, longest, activeToday };
  }

  function rate(accepted, known) { return known ? Math.round((accepted / known) * 100) : null; }

  function periodSummary(events, fromNum, toNum) {
    let submissions = 0; let known = 0; let accepted = 0;
    const solved = new Set(); const perDay = new Array(7).fill(0); const perDaySet = {};
    for (const e of events) {
      const n = keyToNum(dayKey(e.ts));
      if (n < fromNum || n > toNum) continue;
      submissions++;
      if (e.ok === 1 || e.ok === 0) known++;
      if (e.ok === 1) {
        accepted++; solved.add(e.slug);
        (perDaySet[n] = perDaySet[n] || new Set()).add(e.slug);
      }
    }
    Object.keys(perDaySet).forEach((n) => { perDay[weekdayOfNum(Number(n))] += perDaySet[n].size; });
    let best = -1; let bestIdx = -1;
    perDay.forEach((c, i) => { if (c > best) { best = c; bestIdx = i; } });
    return { solved: solved.size, submissions, accepted, acceptance: rate(accepted, known), bestDay: best > 0 ? DAY_NAMES[bestIdx] : null, perDay };
  }

  /**
   * @param {object[]} events   [{id, slug, ts(sec), ok:1|0|null, st, lang, ti, rt, mem, gh}]
   * @param {object}   problems { slug: {slug, number, title, difficulty, topics[], solved} }
   * @param {object}   opts     { now(sec), goal, leetcodeStats, lastRefreshAt, heatmapWeeks }
   */
  function compute(events, problems, opts = {}) {
    const now = opts.now || Math.floor(Date.now() / 1000);
    const todayKey = dayKey(now);
    const todayNum = keyToNum(todayKey);
    problems = problems || {};

    const accepted = events.filter((e) => e.ok === 1);
    const solvedSlugs = new Set(Object.keys(problems).filter((k) => problems[k] && problems[k].solved));
    accepted.forEach((e) => solvedSlugs.add(e.slug));

    const firstAccepted = {};
    accepted.forEach((e) => { if (!firstAccepted[e.slug] || e.ts < firstAccepted[e.slug]) firstAccepted[e.slug] = e.ts; });

    const difficulty = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
    const topicCount = {};
    solvedSlugs.forEach((slug) => {
      const m = problems[slug] || {};
      difficulty[difficulty[m.difficulty] !== undefined ? m.difficulty : 'Unknown']++;
      (m.topics || []).forEach((t) => { topicCount[t] = (topicCount[t] || 0) + 1; });
    });

    const langPairs = new Set(); const langCount = {};
    accepted.forEach((e) => {
      const l = statsLanguage(e.lang); const k = `${e.slug}|${l}`;
      if (!langPairs.has(k)) { langPairs.add(k); langCount[l] = (langCount[l] || 0) + 1; }
    });

    const attempted = new Set(events.map((e) => e.slug)); solvedSlugs.forEach((s) => attempted.add(s));
    const known = events.filter((e) => e.ok === 1 || e.ok === 0).length;

    const activeKeys = new Set(accepted.map((e) => dayKey(e.ts)));
    const st = streaks(activeKeys, todayKey);

    const todayEvents = events.filter((e) => dayKey(e.ts) === todayKey);
    const todaySolved = new Set(todayEvents.filter((e) => e.ok === 1).map((e) => e.slug));
    const newToday = Array.from(solvedSlugs).filter((s) => firstAccepted[s] && dayKey(firstAccepted[s]) === todayKey).length;
    const failedToday = todayEvents.filter((e) => e.ok === 0).length;
    const goal = Number(opts.goal) || 0;

    const weekStart = todayNum - weekdayOfNum(todayNum);
    const week = periodSummary(events, weekStart, todayNum);
    const t = new Date(now * 1000);
    const monthStart = keyToNum(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-01`);
    const month = periodSummary(events, monthStart, todayNum);

    // heatmap: Monday-first week columns, ending with the current week
    const weeks = opts.heatmapWeeks || 16;
    const firstDay = weekStart - (weeks - 1) * 7;
    const perDaySolved = {}; const perDaySubs = {};
    events.forEach((e) => {
      const n = keyToNum(dayKey(e.ts));
      if (n < firstDay) return;
      perDaySubs[n] = (perDaySubs[n] || 0) + 1;
      if (e.ok === 1) (perDaySolved[n] = perDaySolved[n] || new Set()).add(e.slug);
    });
    const heatmap = [];
    for (let n = firstDay; n < firstDay + weeks * 7; n++) {
      heatmap.push({ date: numToKey(n), count: perDaySolved[n] ? perDaySolved[n].size : 0, submissions: perDaySubs[n] || 0, future: n > todayNum });
    }

    const recent = accepted.slice().sort((a, b) => b.ts - a.ts).slice(0, 50).map((e) => {
      const m = problems[e.slug] || {};
      return {
        id: e.id, slug: e.slug, number: m.number || null,
        title: m.title || e.ti || LGS.formatter.titleFromSlug(e.slug),
        difficulty: m.difficulty || null, topics: m.topics || [], lang: statsLanguage(e.lang),
        ts: e.ts, runtime: e.rt || null, memory: e.mem || null, gh: e.gh || null
      };
    });

    const byCount = (o) => Object.entries(o).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      generatedAt: now, dayKey: todayKey,
      hasData: events.length > 0 || solvedSlugs.size > 0,
      solved: solvedSlugs.size, attempted: attempted.size, newToday,
      today: { solved: todaySolved.size, submissions: todayEvents.length, accepted: todayEvents.filter((e) => e.ok === 1).length, failed: failedToday, goal },
      streak: st,
      difficulty,
      acceptance: { rate: rate(accepted.length, known), accepted: accepted.length, total: known },
      topics: byCount(topicCount),
      languages: byCount(langCount),
      week: { solved: week.solved, submissions: week.submissions, acceptance: week.acceptance, bestDay: week.bestDay },
      weekBars: DAY_SHORT.map((label, i) => ({ label, count: week.perDay[i], today: i === weekdayOfNum(todayNum), future: i > weekdayOfNum(todayNum) })),
      month: { solved: month.solved, submissions: month.submissions, acceptance: month.acceptance },
      heatmap,
      recent,
      leetcodeSolved: opts.leetcodeStats ? opts.leetcodeStats.all : null,
      lastRefreshAt: opts.lastRefreshAt || null
    };
  }

  /** Searchable / filterable list of solved problems. */
  function problemList(events, problems, filters = {}) {
    const byslug = {};
    events.filter((e) => e.ok === 1).forEach((e) => {
      const o = byslug[e.slug] || (byslug[e.slug] = { langs: new Set(), last: 0, first: Infinity, rt: null, mem: null });
      o.langs.add(statsLanguage(e.lang));
      if (e.ts > o.last) { o.last = e.ts; o.rt = e.rt || o.rt; o.mem = e.mem || o.mem; }
      if (e.ts < o.first) o.first = e.ts;
    });
    const slugs = new Set(Object.keys(byslug));
    Object.keys(problems || {}).forEach((k) => { if (problems[k] && problems[k].solved) slugs.add(k); });

    const q = String(filters.query || '').trim().toLowerCase();
    let list = Array.from(slugs).map((slug) => {
      const m = (problems || {})[slug] || {}; const o = byslug[slug] || {};
      return {
        slug, number: m.number || null, title: m.title || LGS.formatter.titleFromSlug(slug), difficulty: m.difficulty || null,
        topics: m.topics || [], languages: o.langs ? Array.from(o.langs) : [], lastAt: o.last || 0, firstAt: o.first === Infinity ? 0 : (o.first || 0),
        runtime: o.rt || null, memory: o.mem || null
      };
    });
    if (filters.difficulty && filters.difficulty !== 'All') list = list.filter((p) => p.difficulty === filters.difficulty);
    if (filters.topic && filters.topic !== 'All') list = list.filter((p) => p.topics.includes(filters.topic));
    if (q) {
      list = list.filter((p) => `${p.number || ''} ${p.title} ${p.slug} ${p.difficulty || ''} ${p.topics.join(' ')} ${p.languages.join(' ')}`.toLowerCase().includes(q));
    }
    list.sort((a, b) => b.lastAt - a.lastAt || (parseInt(b.number, 10) || 0) - (parseInt(a.number, 10) || 0));
    return list;
  }

  LGS.analytics = LGS.analytics || {};
  LGS.analytics.stats = { compute, problemList, streaks, dayKey, keyToNum, numToKey, statsLanguage, DAY_NAMES };
})(typeof self !== 'undefined' ? self : window);
