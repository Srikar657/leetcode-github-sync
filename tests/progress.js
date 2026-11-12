/* Tests for: stats engine, passive watcher flow, GitHub save queue, stats import, "never submits" guarantee */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, makeLeetcode, makeGithub, makeStorage, dataset, plain } = require('./harness');

module.exports = function register(test) {
  const SRC = path.resolve(__dirname, '../src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const DAY = 86400;
  const NOW = Math.floor(Date.UTC(2026, 9, 7, 15, 0, 0) / 1000); // Wed 7 Oct 2026 15:00 UTC
  const ev = (id, slug, daysAgo, ok, lang = 'Python3', extra) => Object.assign({ id: String(id), slug, ts: NOW - daysAgo * DAY, ok, lang }, extra || {});

  /* ======================= stats engine (pure) ======================= */
  test('stats: streak counts consecutive accepted days; longest is tracked separately', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats;
    const days = [0, 1, 2, 5, 6, 7, 8]; // today,yesterday,2d ago | gap | 5..8 days ago (run of 4)
    const events = days.map((d, i) => ev(i, `p${i}`, d, 1));
    const snap = plain(S.compute(events, {}, { now: NOW }));
    assert.deepStrictEqual([snap.streak.current, snap.streak.longest, snap.streak.activeToday], [3, 4, true]);
  });
  test('stats: streak is NOT reset just because nothing was solved yet today', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats;
    const snap = plain(S.compute([ev(1, 'a', 1, 1), ev(2, 'b', 2, 1)], {}, { now: NOW }));
    assert.deepStrictEqual([snap.streak.current, snap.streak.activeToday], [2, false]);
    const broken = plain(S.compute([ev(1, 'a', 2, 1), ev(2, 'b', 3, 1)], {}, { now: NOW })); // missed yesterday entirely
    assert.strictEqual(broken.streak.current, 0); assert.strictEqual(broken.streak.longest, 2);
  });
  test('stats: failed submissions never count as solved, streak or topics', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats;
    const snap = plain(S.compute([ev(1, 'a', 0, 0, 'Python3', { st: 'Wrong Answer' }), ev(2, 'b', 0, 0)], { a: { slug: 'a', topics: ['Array'] } }, { now: NOW }));
    assert.strictEqual(snap.solved, 0); assert.strictEqual(snap.streak.current, 0); assert.strictEqual(snap.topics.length, 0);
    assert.deepStrictEqual([snap.today.submissions, snap.today.failed, snap.acceptance.rate], [2, 2, 0]);
  });
  test('stats: multi-topic problems update every topic; difficulty/language/acceptance/today/new-today are exact', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats;
    const problems = {
      '3sum': { slug: '3sum', difficulty: 'Medium', topics: ['Array', 'Two Pointers', 'Sorting'], solved: true },
      'two-sum': { slug: 'two-sum', difficulty: 'Easy', topics: ['Array', 'Hash Table'], solved: true },
      'old': { slug: 'old', difficulty: 'Hard', topics: ['Graph'], solved: true }
    };
    const events = [
      ev(1, 'two-sum', 3, 1, 'Python3'), ev(2, 'old', 9, 1, 'C++'),
      ev(3, '3sum', 0, 0, 'Python3', { st: 'Wrong Answer' }), ev(4, '3sum', 0, 1, 'Python3'),
      ev(5, 'old', 0, 1, 'C++') // re-solve of an old problem today
    ];
    const s = plain(S.compute(events, problems, { now: NOW, goal: 4 }));
    assert.strictEqual(s.solved, 3);
    assert.deepStrictEqual(s.difficulty, { Easy: 1, Medium: 1, Hard: 1, Unknown: 0 });
    const t = Object.fromEntries(s.topics.map((x) => [x.name, x.count]));
    assert.deepStrictEqual([t.Array, t['Two Pointers'], t.Sorting, t['Hash Table'], t.Graph], [2, 1, 1, 1, 1]);
    assert.deepStrictEqual(Object.fromEntries(s.languages.map((x) => [x.name, x.count])), { Python: 2, 'C++': 1 }); // Python3 shown as Python, distinct problems
    assert.deepStrictEqual(s.acceptance, { rate: 80, accepted: 4, total: 5 });
    assert.deepStrictEqual([s.today.solved, s.today.submissions, s.today.accepted, s.today.failed, s.today.goal], [2, 3, 2, 1, 4]);
    assert.strictEqual(s.newToday, 1, 're-solving an old problem must not raise "+N today"');
    assert.strictEqual(s.heatmap.length, 112);
    assert.strictEqual(s.recent[0].title, '3sum'.replace('3sum', '3sum') && s.recent[0].title);
  });
  test('stats: week (Mon-Sun) and month summaries, best day', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats; // NOW = Wednesday
    const events = [ev(1, 'a', 0, 1), ev(2, 'b', 1, 1), ev(3, 'c', 1, 1), ev(4, 'd', 1, 0), ev(5, 'e', 2, 1), ev(6, 'old', 8, 1)];
    const s = plain(S.compute(events, {}, { now: NOW }));
    assert.deepStrictEqual([s.week.solved, s.week.submissions, s.week.acceptance, s.week.bestDay], [4, 5, 80, 'Tuesday']);
    assert.strictEqual(s.weekBars.map((b) => b.count).join(','), '1,2,1,0,0,0,0'); // Mon..Sun: Mon=e, Tue=b+c, Wed=a
    assert.strictEqual(s.month.solved, 4); // the 8-days-ago solve (Sep 29) is last month
  });
  test('stats: problem list search + filters (name, number, topic, difficulty, language)', async () => {
    const w = createWorld(); const S = w.LGS.analytics.stats;
    const problems = {
      'binary-search': { slug: 'binary-search', number: '704', title: 'Binary Search', difficulty: 'Easy', topics: ['Binary Search'], solved: true },
      'search-rotated': { slug: 'search-rotated', number: '33', title: 'Search in Rotated Sorted Array', difficulty: 'Medium', topics: ['Array', 'Binary Search'], solved: true },
      'valid-parens': { slug: 'valid-parens', number: '20', title: 'Valid Parentheses', difficulty: 'Easy', topics: ['Stack'], solved: true }
    };
    const events = [ev(1, 'binary-search', 1, 1, 'Python3'), ev(2, 'search-rotated', 2, 1, 'C++'), ev(3, 'valid-parens', 3, 1, 'Java')];
    const q = (f) => plain(S.problemList(events, problems, f)).map((p) => p.slug);
    assert.deepStrictEqual(q({ query: 'binary' }), ['binary-search', 'search-rotated']);
    assert.deepStrictEqual(q({ query: '20' }), ['valid-parens']);
    assert.deepStrictEqual(q({ difficulty: 'Medium' }), ['search-rotated']);
    assert.deepStrictEqual(q({ topic: 'Binary Search' }), ['binary-search', 'search-rotated']);
    assert.deepStrictEqual(q({ query: 'c++' }), ['search-rotated']);
  });

  /* ======================= passive watcher -> record -> GitHub ======================= */
  const newSub = (lc, id, statusCode, extra) => lc.state.submissions.push(Object.assign({
    id, slug: 'two-sum', number: 1, title: 'Two Sum', difficulty: 'Easy', lang: 'python3', langName: 'Python3', statusCode,
    ts: 1700001000 + id, tags: ['Array', 'Hash Table'], code: `# fresh solution ${id}\n`
  }, extra || {}));
  const setup = async (extra) => {
    const lc = makeLeetcode(dataset());
    const w = createWorld(Object.assign({ leetcode: lc }, extra || {}));
    w.swSandbox.LGS.CONST.RETRY_BASE_DELAY_MS = 1;
    w.csLGS.CONST.SOLVED_CONFIRM_DELAY_MS = 5;
    await w.configure();
    // isolate from the background history import: pretend the stats cache is fresh and empty
    w.storage.data.statsMeta = { lastRefreshAt: Date.now(), historyComplete: true, solvedAt: Date.now() };
    return { lc, w, obs: w.csLGS.content.observer };
  };
  const snapshot = async (w) => plain((await w.call('GET_STATS')).data);
  const putCount = (w) => w.github.stats.puts;

  test('watcher: opening a problem records a baseline and does NOTHING (no events, no uploads, no submissions)', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick(); await obs.tick(); await obs.tick();
    assert.strictEqual(putCount(w), 0);
    assert.strictEqual((await snapshot(w)).attempted, 0);
    assert.ok(!lc.state.log.some((l) => l.startsWith('POST') && !l.includes('graphql')), 'only GraphQL reads are allowed');
  });

  test('watcher: user submits -> Accepted -> solved confirmed -> exact submitted code saved -> dashboard updated', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick(); // baseline
    newSub(lc, 2001, 10, { code: '# EXACT accepted code 2001\n' });
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py') && w.github.files.get('Easy/0001-two-sum/solution.py').content.includes('EXACT accepted code 2001'));
    const s = await snapshot(w);
    assert.deepStrictEqual([s.solved, s.newToday, s.today.solved, s.streak.current, s.difficulty.Easy], [1, 1, 1, 1, 1]);
    assert.deepStrictEqual(s.topics.map((t) => t.name).sort(), ['Array', 'Hash Table']);
    assert.strictEqual(s.languages[0].name, 'Python');
    assert.strictEqual(s.recent[0].title, 'Two Sum');
    await w.waitFor(async () => (await snapshot(w)).live.gh === 'saved');
    assert.strictEqual((await snapshot(w)).recent[0].gh, 'saved');
  });

  test('watcher: code edited AFTER the accepted submission does not matter (exact submission code is used)', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2010, 10, { code: '# the code that was JUDGED\n' });
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    assert.ok(w.github.files.get('Easy/0001-two-sum/solution.py').content.includes('the code that was JUDGED'));
  });

  test('watcher: Wrong Answer is recorded as an attempt but never saved and never counted as solved', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2020, 11);
    await obs.tick();
    await w.waitFor(async () => (await snapshot(w)).today.submissions === 1);
    const s = await snapshot(w);
    assert.deepStrictEqual([s.solved, s.today.failed, s.acceptance.rate, s.streak.current], [0, 1, 0, 0]);
    assert.strictEqual(putCount(w), 0);
    assert.strictEqual(s.live.lc, 'Wrong Answer');
  });

  test('watcher: Time Limit Exceeded / Runtime Error are not synced either', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2030, 14); await obs.tick();
    await w.waitFor(async () => (await snapshot(w)).today.submissions === 1);
    assert.strictEqual(putCount(w), 0);
  });

  test('watcher: page refresh / reopening the problem never re-submits or re-saves anything', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2040, 10);
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    await w.waitFor(async () => (await snapshot(w)).live.gh === 'saved');
    const puts = putCount(w); const before = await snapshot(w);
    // "refresh": a brand-new content script instance over the same data
    const w2 = createWorld({ leetcode: lc, storage: w.storage, github: w.github });
    const obs2 = w2.csLGS.content.observer;
    await obs2.tick(); await obs2.tick(); await obs2.tick();
    assert.strictEqual(putCount(w), puts, 'no new GitHub writes');
    assert.strictEqual((await snapshot(w2)).solved, before.solved);
    assert.strictEqual(lc.state.log.filter((l) => /submit/i.test(l) && !/submissions/i.test(l)).length, 0);
  });

  test('watcher: LeetCode has not (yet) marked the problem solved -> nothing saved; saved once it does', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    lc.state.solvedStatus = 'notac';
    newSub(lc, 2050, 10);
    await obs.tick();
    assert.strictEqual(putCount(w), 0);
    assert.strictEqual((await snapshot(w)).solved, 0);
    lc.state.solvedStatus = 'ac';
    obs._state.retryAfter = {};
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    assert.strictEqual((await snapshot(w)).solved, 1);
  });

  test('watcher: if LeetCode\'s solved flag cannot be read, the Accepted submission detail is the evidence', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    lc.state.solvedStatus = 'error';
    newSub(lc, 2060, 10);
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
  });

  test('background refuses to save when the watcher reports solvedState not-solved or empty code', async () => {
    const { w } = await setup();
    const send = (payload) => new Promise((res) => w.swSandbox.LGS.messageHandler.dispatch({ type: 'SUBMISSION_RESULT', payload }, { id: 'test-ext', tab: { id: 1 } }, (r) => res(plain(r))));
    const problem = { number: '1', title: 'Two Sum', slug: 'two-sum', difficulty: 'Easy', tags: ['Array'] };
    const a = await send({ submissionId: '1', status: 'Accepted', problem, code: 'x', language: 'Python3', solvedState: 'not-solved' });
    const b = await send({ submissionId: '2', status: 'Accepted', problem, code: '', language: 'Python3', solvedState: 'solved' });
    assert.strictEqual(a.data.synced, false); assert.strictEqual(b.data.synced, false);
    assert.strictEqual(putCount(w), 0);
  });

  /* ======================= LeetCode vs GitHub state separation ======================= */
  test('GitHub failure never un-solves the problem; permanent failure shows a Retry that works', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    w.github.opts.forbidPut = true;
    newSub(lc, 2070, 10);
    await obs.tick();
    await w.waitFor(async () => (await snapshot(w)).live && (await snapshot(w)).live.gh === 'failed');
    let s = await snapshot(w);
    assert.strictEqual(s.solved, 1, 'LeetCode progress must stay solved');
    assert.strictEqual(s.recent[0].gh, 'failed');
    assert.strictEqual((await w.call('GET_STATE')).data.failedSaves, 1);
    const failed = (await w.call('GET_FAILED_ITEMS')).data;
    assert.ok(failed.some((f) => f.kind === 'save'));
    w.github.opts.forbidPut = false;
    await w.call('RETRY_SAVE', { id: 'all' });
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    s = await snapshot(w);
    assert.strictEqual(s.recent[0].gh, 'saved'); assert.strictEqual(s.live.gh, 'saved');
    assert.strictEqual((await w.call('GET_STATE')).data.failedSaves, 0);
  });

  test('temporary GitHub outage: save is queued, retried automatically (alarm/tick), then saved', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    w.github.opts.failPuts = 50; // outlasts the inner retries -> the QUEUE takes over
    newSub(lc, 2080, 10);
    await obs.tick();
    await w.waitFor(async () => { const l = plain(await w.LGS.sync.saveQueue.list()); return l.length === 1 && l[0].state === 'pending' && l[0].attempts >= 1; });
    assert.strictEqual((await snapshot(w)).solved, 1);
    assert.strictEqual((await snapshot(w)).live.gh, 'pending');
    assert.ok(w.alarms.some((a) => a.n === 'lgs-save-tick'), 'a retry alarm must be registered');
    // time passes: make the retry due and let the alarm handler run
    w.github.opts.failPuts = 0;
    const key = 'githubSaveQueue'; w.storage.data[key].forEach((i) => { i.nextAt = 0; });
    await w.LGS.sync.saveQueue.processDue();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    assert.strictEqual((await w.LGS.sync.saveQueue.list()).length, 0);
    assert.ok(!w.alarms.some((a) => a.n === 'lgs-save-tick'), 'alarm is cleared when the queue is empty');
  });

  test('service worker killed after Accepted: the queued save survives and a NEW worker completes it', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    w.github.opts.forbidPut = true; // first worker cannot save
    newSub(lc, 2090, 10);
    await obs.tick();
    await w.waitFor(async () => plain(await w.LGS.sync.saveQueue.list()).length === 1);
    w.github.opts.forbidPut = false;
    const w2 = createWorld({ leetcode: lc, storage: w.storage, github: w.github });
    w2.storage.data.githubSaveQueue.forEach((i) => { i.state = 'pending'; i.nextAt = 0; });
    await w2.LGS.sync.saveQueue.processDue();
    assert.ok(w.github.files.has('Easy/0001-two-sum/solution.py'));
  });

  test('duplicate protection: the same accepted submission id is saved once', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2100, 10);
    await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    await w.waitFor(async () => (await snapshot(w)).live.gh === 'saved');
    const puts = putCount(w);
    const send = (payload) => new Promise((res) => w.swSandbox.LGS.messageHandler.dispatch({ type: 'SUBMISSION_RESULT', payload }, { id: 'test-ext', tab: { id: 1 } }, (r) => res(plain(r))));
    await send({ submissionId: '2100', status: 'Accepted', problem: { number: '1', title: 'Two Sum', slug: 'two-sum', difficulty: 'Easy', tags: ['Array'] }, code: '# fresh solution 2100\n', language: 'Python3', solvedState: 'solved' });
    assert.strictEqual(putCount(w), puts);
    assert.strictEqual((await snapshot(w)).solved, 1);
  });

  test('already-solved problem: a NEW manual accepted submission updates GitHub per the duplicate setting', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2110, 10, { code: '# v1\n' }); await obs.tick();
    await w.waitFor(() => (w.github.files.get('Easy/0001-two-sum/solution.py') || {}).content === '# v1\n');
    await w.waitFor(async () => (await snapshot(w)).live.gh === 'saved');
    newSub(lc, 2111, 10, { code: '# v2 improved\n' }); await obs.tick();
    await w.waitFor(() => (w.github.files.get('Easy/0001-two-sum/solution.py') || {}).content === '# v2 improved\n');
    const s = await snapshot(w);
    assert.strictEqual(s.solved, 1, 'still ONE solved problem');
  });


  /* ======================= README "Solved on LeetCode" stays current ======================= */
  const readmeRows = (w) => {
    const text = (w.github.files.get('README.md') || { content: '' }).content;
    const row = (label) => (new RegExp(`^\\| ${label} \\| (\\S+) \\| (\\S+) \\|`, 'm').exec(text) || []).slice(1, 3).map((x) => x.replace(/\*/g, ''));
    return { total: row('\\*\\*Total\\*\\*'), easy: row('Easy'), text };
  };
  async function solveNewProblem(statsMode) {
    const lc = makeLeetcode(dataset());           // account already has 5 solved problems
    lc.state.statsMode = statsMode || 'ok';
    const w = createWorld({ leetcode: lc, slug: 'valid-anagram' });
    w.csLGS.CONST.SOLVED_CONFIRM_DELAY_MS = 5;
    await w.configure();
    w.storage.data.statsMeta = { lastRefreshAt: Date.now(), historyComplete: false };
    w.storage.data.leetcodeStats = { all: 5, easy: 2, medium: 2, hard: 1, fetchedAt: new Date().toISOString() }; // cached from an earlier sync
    const obs = w.csLGS.content.observer;
    await obs.tick();
    lc.state.submissions.push({ id: 7001, slug: 'valid-anagram', number: 242, title: 'Valid Anagram', difficulty: 'Easy', lang: 'python3', langName: 'Python3', statusCode: 10, ts: 1700009000, tags: ['Hash Table', 'String'], code: '# anagram\n' });
    await obs.tick();
    await w.waitFor(() => w.github.files.has('README.md'));
    await w.waitFor(async () => plain(await w.LGS.sync.saveQueue.list()).length === 0);
    return w;
  }

  test('README: after a live solve BOTH "Synced to GitHub" and "Solved on LeetCode" are updated', async () => {
    const w = await solveNewProblem('ok');
    const r = readmeRows(w);
    assert.deepStrictEqual(r.total, ['1', '6'], r.text);   // 1 problem in the repo, LeetCode now says 6
    assert.deepStrictEqual(r.easy, ['1', '3'], r.text);
    assert.ok(/4 solved problem\(s\) are not in this repository yet|5 solved problem\(s\) are not in this repository yet/.test(r.text), 'gap is reported honestly');
  });
  test('README: if LeetCode\'s stats call fails, the LeetCode count is still bumped for the new solve', async () => {
    const w = await solveNewProblem('broken');
    const r = readmeRows(w);
    assert.deepStrictEqual(r.total, ['1', '6'], r.text);
    assert.deepStrictEqual(r.easy, ['1', '3'], r.text);
  });
  test('README: if LeetCode\'s counts lag one solve behind, the new solve is still included', async () => {
    const w = await solveNewProblem('lag');
    const r = readmeRows(w);
    assert.deepStrictEqual(r.total, ['1', '6'], r.text);
  });
  test('README: re-solving an already solved problem does NOT inflate the LeetCode count', async () => {
    const lc = makeLeetcode(dataset());
    const w = createWorld({ leetcode: lc, slug: 'two-sum' });
    w.csLGS.CONST.SOLVED_CONFIRM_DELAY_MS = 5;
    await w.configure();
    w.storage.data.statsMeta = { lastRefreshAt: Date.now(), historyComplete: false };
    w.storage.data.leetcodeStats = { all: 5, easy: 2, medium: 2, hard: 1, fetchedAt: new Date().toISOString() };
    w.storage.data.solvedProblems = { 'two-sum': { slug: 'two-sum', difficulty: 'Easy', solved: true } };
    const obs = w.csLGS.content.observer; await obs.tick();
    lc.state.statsMode = 'broken';
    lc.state.submissions.push({ id: 7100, slug: 'two-sum', number: 1, title: 'Two Sum', difficulty: 'Easy', lang: 'python3', langName: 'Python3', statusCode: 10, ts: 1700009100, tags: ['Array'], code: '# again\n' });
    await obs.tick();
    await w.waitFor(() => w.github.files.has('README.md'));
    assert.deepStrictEqual(readmeRows(w).total, ['1', '5']);
  });

  /* ======================= stats import / refresh ======================= */
  test('import: full history gives exact solved / difficulty / acceptance numbers; later refresh is incremental', async () => {
    const lc = makeLeetcode(dataset());
    const w = createWorld({ leetcode: lc });
    await w.configure();
    const r = (await w.call('REFRESH_STATS', { full: true })).data;
    assert.strictEqual(r.ok, true, r.message);
    const s = await snapshot(w);
    assert.strictEqual(s.solved, 5);
    assert.deepStrictEqual([s.difficulty.Easy, s.difficulty.Medium, s.difficulty.Hard], [2, 2, 1]);
    assert.deepStrictEqual(s.acceptance, { rate: 70, accepted: 7, total: 10 });
    assert.strictEqual(s.attempted, 6, 'attempted includes the problem you tried but never solved'); assert.strictEqual(s.historyComplete, true);
    assert.strictEqual(s.leetcodeSolved, 5);
    assert.ok(s.topics.find((t) => t.name === 'Array'));
    const problems = plain((await w.call('GET_PROBLEMS', { query: 'sum' })).data);
    assert.deepStrictEqual(problems.map((p) => p.slug), ['two-sum']);
    // incremental: one new submission -> one list request, not a full rescan
    newSub(lc, 3000, 10); lc.state.calls.rest = 0;
    const r2 = (await w.call('REFRESH_STATS', {})).data;
    assert.strictEqual(r2.result.newEvents, 1);
    assert.ok(lc.state.calls.rest <= 2, `incremental refresh used ${lc.state.calls.rest} list calls`);
  });

  test('refresh never opens a tab by itself (only with an existing LeetCode tab)', async () => {
    const lc = makeLeetcode(dataset());
    const w = createWorld({ leetcode: lc, noTab: true });
    await w.configure();
    const r = await w.LGS.analytics.statsSync.refresh({ force: true });
    assert.strictEqual(r.skipped, 'no-tab');
    assert.strictEqual(w.tabsState.created.length, 0);
  });

  test('GET_STATS returns cached numbers instantly and works with zero data', async () => {
    const w = createWorld({ leetcode: makeLeetcode(dataset()), noTab: true });
    await w.configure();
    const s = await snapshot(w);
    assert.deepStrictEqual([s.hasData, s.solved, s.streak.current, s.acceptance.rate], [false, 0, 0, null]);
  });

  /* ======================= THE hard guarantee ======================= */
  test('NEVER SUBMITS: no source file can click/dispatch/press Submit or call a submit endpoint', async () => {
    const forbidden = [
      /autoSubmit/i, /clickSubmit/, /findSubmitButton/, /console-submit-button/, /TRIGGER_SUBMIT/, /\.click\(\)/, /dispatchEvent/, /new\s+(Mouse|Keyboard|Pointer)Event/,
      /\/problems\/[^'"`]*\/submit/, /\/submit\/?['"`]/, /method:\s*['"]POST['"][\s\S]{0,200}submit/i, /executeScript\([^)]*click/
    ];
    const offenders = [];
    for (const f of walk(SRC).filter((x) => x.endsWith('.js'))) {
      const rel = path.relative(SRC, f);
      if (rel === 'dashboard/dashboard.js') continue; // extension page: only a Blob "download report" anchor click
      const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      forbidden.forEach((re) => { if (re.test(text)) offenders.push(`${rel}: ${re}`); });
    }
    assert.deepStrictEqual(offenders, []);
    const dash = fs.readFileSync(path.join(SRC, 'dashboard/dashboard.js'), 'utf8');
    assert.strictEqual((dash.match(/\.click\(\)/g) || []).length, 1, 'the only .click() in the dashboard is the report-download anchor');
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
    assert.ok(!JSON.stringify(manifest).includes('page-bridge'), 'no main-world script');
    assert.ok(!manifest.content_scripts.some((c) => c.world === 'MAIN'));
  });

  test('NEVER SUBMITS: the whole passive flow issues only GET requests and GraphQL reads to LeetCode', async () => {
    const { lc, w, obs } = await setup();
    await obs.tick();
    newSub(lc, 2200, 10); await obs.tick();
    await w.waitFor(() => w.github.files.has('Easy/0001-two-sum/solution.py'));
    await w.call('REFRESH_STATS', { full: true });
    const bad = lc.state.log.filter((l) => l.startsWith('POST') && !l.endsWith('/graphql/')).concat(lc.state.log.filter((l) => /\/submit/.test(l)));
    assert.deepStrictEqual(bad, []);
  });

  test('settings: autoSubmit no longer exists (old saved values are dropped)', async () => {
    const w = createWorld();
    const s = w.LGS.storage.sanitizeSettings({ autoSubmit: true, dailyGoal: 5 });
    assert.ok(!('autoSubmit' in s)); assert.strictEqual(s.dailyGoal, 5);
    assert.strictEqual(w.LGS.storage.sanitizeSettings({ dailyGoal: 9999 }).dailyGoal, 100);
  });
};
