process.env.TZ = 'UTC';
const assert = require('assert');
const { createWorld, makeLeetcode, makeGithub, makeStorage, dataset, plain } = require('./harness');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const DONE = ['completed', 'error', 'paused', 'waiting', 'cancelled'];
async function runHistorical(w, opts) {
  await w.call('SYNC_HISTORICAL_START', opts || {});
  return w.waitProgress(DONE, 20000);
}
const paths = (w) => Array.from(w.github.files.keys()).sort();

/* ======================= unit: status detection ======================= */
test('status: every field shape is understood, null is "unknown" not "Unknown Error"', async () => {
  const w = createWorld();
  const S = w.LGS.leetcode.status;
  const r = (o) => S.fromSubmissionRecord(o).status;
  assert.strictEqual(r({ statusDisplay: 'Accepted' }), 'Accepted');
  assert.strictEqual(r({ statusDisplay: null, status_display: 'Accepted' }), 'Accepted');
  assert.strictEqual(r({ statusDisplay: null, status_msg: 'Wrong Answer' }), 'Wrong Answer');
  assert.strictEqual(r({ statusDisplay: null, status: 10 }), 'Accepted');
  assert.strictEqual(r({ status: '10' }), 'Accepted');
  assert.strictEqual(r({ status: 'AC' }), 'Accepted');
  assert.strictEqual(r({ statusCode: 11 }), 'Wrong Answer');
  assert.strictEqual(r({ statusDisplay: null, status: null }), null);
  assert.strictEqual(r({ statusDisplay: 'something new' }), null);
  assert.strictEqual(r(null), null);
  assert.strictEqual(S.fromText(null), 'Unknown Error'); // legacy behaviour preserved, never Accepted
});

test('status: verifyAccepted - detail beats list hint, nothing known = not accepted', async () => {
  const w = createWorld();
  const v = w.LGS.leetcode.status.verifyAccepted;
  assert.strictEqual(v('Accepted', { statusCode: 11 }).accepted, false);   // detail overrules a wrong hint
  assert.strictEqual(v(null, { statusCode: 10 }).accepted, true);          // detail alone is enough
  assert.strictEqual(v('Accepted', { statusCode: null }).accepted, true);  // falls back to the list
  assert.strictEqual(v(null, { statusCode: null }).accepted, false);       // unverifiable -> refuse
  assert.strictEqual(v(null, null).accepted, false);
});

/* ======================= the headline bug ======================= */
for (const [label, cfg] of [
  ['REST status null + GraphQL status null (REST works)', { restMode: 'statusNull', gqlListMode: 'statusNull' }],
  ['REST broken, GraphQL statusDisplay: null (the reported case)', { restMode: 'broken', gqlListMode: 'statusNull' }],
  ['REST ok with status_display (normal case)', {}]
]) {
  test(`historical sync works when: ${label}`, async () => {
    const lc = makeLeetcode(dataset()); Object.assign(lc.state, cfg);
    const w = createWorld({ leetcode: lc });
    await w.configure();
    const p = await runHistorical(w);
    assert.strictEqual(p.state, 'completed', p.error);
    assert.strictEqual(p.failed, 0);
    const solutions = paths(w).filter((x) => /solution\./.test(x));
    assert.deepStrictEqual(solutions, [
      'Easy/0001-two-sum/solution.cpp', 'Easy/0001-two-sum/solution.py', 'Easy/0020-valid-parentheses/solution.rs',
      'Hard/0004-median-of-two-sorted-arrays/solution.py', 'Medium/0002-add-two-numbers/solution.java', 'Medium/0007-reverse-integer/solution.go'
    ]);
    // never-accepted problem must not appear anywhere
    assert.ok(!paths(w).some((x) => /longest-palindromic/.test(x)));
    // wrong-answer attempt must not leak: two-sum.py holds the ACCEPTED run (id 1002), not the WA run (1001)
    assert.ok(w.github.files.get('Easy/0001-two-sum/solution.py').content.includes('// run 1002'));
    // 'latest' strategy: add-two-numbers uses the later accepted submission
    assert.ok(w.github.files.get('Medium/0002-add-two-numbers/solution.java').content.includes('// run 1006'));
    // README is generated once, with verified LeetCode stats
    const readme = w.github.files.get('README.md').content;
    assert.ok(readme.includes('LEETCODE-SYNC-START') && readme.includes('Two Sum'));
    assert.ok(readme.includes('Solved on LeetCode'));
    assert.ok(w.github.files.has('TOPICS.md'));
  });
}

test('historical: README is written ONCE (not per problem) and re-run performs zero writes', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  await runHistorical(w);
  const readmeWrites = w.github.stats.putPaths.filter((x) => x === 'README.md').length;
  assert.strictEqual(readmeWrites, 1);
  const before = w.github.stats.puts;
  const p2 = await runHistorical(w);
  assert.strictEqual(p2.state, 'completed');
  assert.strictEqual(w.github.stats.puts, before, 'second run must not write anything');
  assert.strictEqual(p2.created, 0); assert.ok(p2.unchanged >= 6);
});

test('verification: a list that says Accepted but whose DETAIL says Wrong Answer is never synced', async () => {
  const rows = dataset();
  const lc = makeLeetcode(rows);
  const w = createWorld({ leetcode: lc });
  // make the list lie for the never-accepted problem
  const origHandle = lc.handle;
  lc.handle = async (url, init) => {
    const r = await origHandle(url, init);
    if (/api\/submissions/.test(url)) {
      const body = JSON.parse(await r.text());
      body.submissions_dump.forEach((s) => { if (s.title_slug === 'longest-palindromic-substring') s.status_display = 'Accepted'; });
      return { ok: true, status: 200, redirected: false, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    }
    return r;
  };
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed');
  assert.ok(!paths(w).some((x) => /longest-palindromic/.test(x)), 'detail says WA, so it must be refused');
  assert.ok(p.notAccepted >= 1);
});

test('verification: no status anywhere (list null + detail has none) => nothing is synced', async () => {
  const lc = makeLeetcode(dataset());
  Object.assign(lc.state, { restMode: 'statusNull', gqlListMode: 'statusNull', detailHasStatus: false });
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed');
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 0);
  assert.ok(p.notAccepted >= 6);
});

/* ======================= pagination ======================= */
test('pagination: server caps page size below the requested size - nothing is skipped', async () => {
  const rows = [];
  for (let i = 0; i < 70; i++) rows.push({ id: 5000 + i, slug: `p-${i}`, number: i + 1, title: `P ${i}`, difficulty: 'Easy', lang: 'python3', langName: 'Python3', statusCode: 10, ts: 1700000000 + i, tags: [], code: `print(${i})` });
  const lc = makeLeetcode(rows); lc.state.pageCap = 7; // asked 100, gets 7
  const w = createWorld({ leetcode: lc });
  await w.configure({ historicalPageSize: 100 });
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(paths(w).filter((x) => /solution\.py$/.test(x)).length, 70);
  // the SCAN alone must have found everything (the solved-list gap fill must not be what saved us)
  const disc = w.storage.data.historicalDiscovery;
  assert.strictEqual(disc.scanned, 70);
  assert.strictEqual(disc.fillDone.length, 0, 'scan skipped submissions; only the fallback rescued them');
});

test('pagination: a server that ignores offset aborts instead of looping forever', async () => {
  const lc = makeLeetcode(dataset()); lc.state.restMode = 'broken'; lc.state.gqlListMode = 'ignoreOffset'; lc.state.pageCap = 3;
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w);
  assert.ok(['error'].includes(p.state), `expected error, got ${p.state}`);
  assert.ok(/same page twice|not advancing/i.test(p.error), p.error);
});

test('fallback: both list sources dead => per-problem fill from the solved list still works', async () => {
  const lc = makeLeetcode(dataset());
  const orig = lc.handle;
  lc.handle = async (url, init) => {
    if (/api\/submissions\/$|api\/submissions\/\?/.test(new URL(url).pathname + new URL(url).search) && !/api\/submissions\/[a-z]/.test(url)) return { ok: false, status: 404, redirected: false, headers: { get: () => null }, text: async () => 'x' };
    if (init && init.body && /submissionList/.test(init.body) && !JSON.parse(init.body).variables.questionSlug) return { ok: true, status: 200, redirected: false, headers: { get: () => null }, text: async () => JSON.stringify({ errors: [{ message: 'Cannot query field "x"' }] }) };
    return orig(url, init);
  };
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 6);
});

/* ======================= dry run ======================= */
test('dry run: reports everything, writes NOTHING to GitHub', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w, { dryRun: true });
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(w.github.stats.puts, 0);
  assert.strictEqual(p.created, 6);          // "would create"
  const rep = plain(await w.LGS.sync.historicalSync.getReport());
  assert.strictEqual(rep.items.filter((i) => i.outcome === 'would-create').length, 6);
  // after a dry run a real run still works and reuses the scan
  const calls = lc.state.calls.list + lc.state.calls.rest;
  const p2 = await runHistorical(w, {});
  assert.strictEqual(p2.state, 'completed');
  assert.strictEqual(lc.state.calls.list + lc.state.calls.rest, calls, 'scan must be reused, not repeated');
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 6);
});

test('only-new mode skips problems already in the repository without fetching them', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  await runHistorical(w);
  const details = lc.state.calls.detail;
  const p = await runHistorical(w, { onlyNew: true, reuseDiscovery: false });
  assert.strictEqual(p.total, 0);
  assert.strictEqual(lc.state.calls.detail, details, 'no detail fetches for problems already synced');
});

/* ======================= ask mode / conflicts ======================= */
test('duplicate "ask": differing file is parked, then overwritten on request', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  w.github.files.set('Easy/0020-valid-parentheses/solution.rs', { content: 'old\n', sha: require('./harness').gitSha('old\n') });
  await w.configure({ duplicateHandling: 'ask' });
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(p.pendingDecision, 1);
  assert.strictEqual(w.github.files.get('Easy/0020-valid-parentheses/solution.rs').content, 'old\n');
  const pending = (await w.call('GET_PENDING_DECISIONS')).data;
  assert.strictEqual(pending.length, 1);
  assert.ok(!('model' in pending[0]), 'UI view must not carry source code');
  const r = (await w.call('RESOLVE_DECISION', { id: pending[0].id, action: 'overwrite' })).data;
  assert.strictEqual(r.resolved, 1, JSON.stringify(r));
  assert.ok(w.github.files.get('Easy/0020-valid-parentheses/solution.rs').content.includes('valid-parentheses'));
  assert.strictEqual((await w.call('GET_PENDING_DECISIONS')).data.length, 0);
});

test('duplicate "skip" keeps GitHub version; "update" replaces it', async () => {
  for (const [mode, expectOld] of [['skip', true], ['update', false]]) {
    const lc = makeLeetcode(dataset());
    const w = createWorld({ leetcode: lc });
    w.github.files.set('Easy/0020-valid-parentheses/solution.rs', { content: 'old\n', sha: require('./harness').gitSha('old\n') });
    await w.configure({ duplicateHandling: mode });
    await runHistorical(w);
    assert.strictEqual(w.github.files.get('Easy/0020-valid-parentheses/solution.rs').content === 'old\n', expectOld, mode);
  }
});

test('GitHub 409: latest sha is re-fetched (the stale sha is not resent)', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  w.github.files.set('Easy/0020-valid-parentheses/solution.rs', { content: 'old\n', sha: require('./harness').gitSha('old\n') });
  w.github.opts.conflictOnce.add('Easy/0020-valid-parentheses/solution.rs');
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(p.failed, 0);
  assert.ok(w.github.files.get('Easy/0020-valid-parentheses/solution.rs').content.includes('valid-parentheses'));
});

test('GitHub secondary rate limit (short) is waited out and retried', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  w.github.opts.rateLimitPuts = 1;
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed', p.error);
  assert.strictEqual(p.failed, 0);
});

test('GitHub long rate limit parks the job in "waiting" (with an alarm) instead of failing', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc, maxInlineWaitMs: 100 });
  w.github.opts.rateLimitPuts = 1;
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'waiting', p.error);
  assert.ok(p.waitUntil > Date.now());
  assert.ok(w.alarms.some((a) => a.n === 'lgs-job-wake'));
  // wake it up
  w.swSandbox.LGS.CONST.MAX_INLINE_WAIT_MS = 90000;
  await w.LGS.sync.historicalSync.resume();
  const p2 = await w.waitProgress(['completed', 'error'], 20000);
  assert.strictEqual(p2.state, 'completed', p2.error);
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 6);
});

test('GitHub permission errors stop the job after 3 repeats instead of failing everything silently', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  w.github.opts.forbidPut = true;
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'error');
  assert.ok(/permission/i.test(p.error));
  const failed = (await w.call('GET_FAILED_ITEMS')).data;
  assert.ok(failed.length >= 3 && failed.every((f) => f.category === 'permission' && f.retryable === false));
});

/* ======================= auth, resume, restart ======================= */
test('LeetCode session expiry mid-run pauses; resume completes the remaining items', async () => {
  const lc = makeLeetcode(dataset());
  lc.state.failDetailAfter = 2; // 403 after two detail calls
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'paused', p.error);
  assert.ok(/log into LeetCode/i.test(p.error));
  const done = p.processed;
  assert.ok(done >= 1 && done < p.total);
  lc.state.failDetailAfter = null;
  await w.call('SYNC_HISTORICAL_RESUME');
  const p2 = await w.waitProgress(['completed', 'error'], 20000);
  assert.strictEqual(p2.state, 'completed', p2.error);
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 6);
});

test('service worker killed mid-job: a NEW worker resumes from the checkpoint via the alarm tick', async () => {
  const storage = makeStorage();
  const github = makeGithub();
  const lc = makeLeetcode(dataset());
  lc.state.failDetailAfter = 3;
  const w1 = createWorld({ leetcode: lc, storage, github });
  await w1.configure();
  const p1 = await runHistorical(w1);
  assert.strictEqual(p1.state, 'paused');
  // Simulate a hard kill: persisted state says "running", but no loop exists in the next worker.
  lc.state.failDetailAfter = null;
  const prog = storage.data.historicalProgress; prog.state = 'running'; prog.error = null;
  const w2 = createWorld({ leetcode: lc, storage, github });
  assert.ok(!w2.LGS.sync.historicalSync.isRunning());
  await w2.LGS.sync.historicalSync.tick();
  const p2 = await w2.waitProgress(['completed', 'error'], 20000);
  assert.strictEqual(p2.state, 'completed', p2.error);
  assert.strictEqual(paths(w2).filter((x) => /solution\./.test(x)).length, 6);
});

test('discovery checkpoint: a restarted worker continues scanning from the saved offset', async () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ id: 9000 + i, slug: `q-${i}`, number: i + 1, title: `Q ${i}`, difficulty: 'Easy', lang: 'python3', langName: 'Python3', statusCode: 10, ts: 1700000000 + i, tags: [], code: `x=${i}` });
  const storage = makeStorage(); const github = makeGithub();
  const lc = makeLeetcode(rows); lc.state.pageCap = 20;
  const w1 = createWorld({ leetcode: lc, storage, github });
  await w1.configure();
  // die during the scan: make the 3rd list call fail hard (auth), leaving a checkpoint behind
  const orig = lc.handle; let n = 0;
  lc.handle = async (u, i) => { if (/api\/submissions\/\?/.test(u) && ++n === 3) return { ok: false, status: 403, redirected: false, headers: { get: () => null }, text: async () => 'forbidden' }; return orig(u, i); };
  const p1 = await runHistorical(w1);
  assert.strictEqual(p1.state, 'paused');
  const disc = storage.data.historicalDiscovery;
  assert.strictEqual(disc.offset, 40); assert.strictEqual(disc.phase, 'scanning');
  lc.handle = orig; lc.state.calls.rest = 0;
  const w2 = createWorld({ leetcode: lc, storage, github });
  await w2.call('SYNC_HISTORICAL_RESUME');
  const p2 = await w2.waitProgress(['completed', 'error'], 20000);
  assert.strictEqual(p2.state, 'completed', p2.error);
  assert.ok(lc.state.calls.rest <= 3, `should only scan the last page, scanned ${lc.state.calls.rest}`);
  assert.strictEqual(paths(w2).filter((x) => /solution\.py$/.test(x)).length, 60);
});

test('pause then resume, and cancel', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure({ leetcodeRequestDelayMs: 40 });
  await w.call('SYNC_HISTORICAL_START', {});
  await w.call('SYNC_HISTORICAL_PAUSE');
  const p = await w.waitProgress(['paused', 'completed'], 10000);
  if (p.state === 'paused') {
    await w.call('SYNC_HISTORICAL_RESUME');
    assert.strictEqual((await w.waitProgress(['completed', 'error'], 20000)).state, 'completed');
  }
  await w.call('SYNC_HISTORICAL_START', { reuseDiscovery: false });
  await w.call('SYNC_HISTORICAL_CANCEL');
  const c = await w.waitProgress(['cancelled', 'completed'], 10000);
  assert.ok(['cancelled', 'completed'].includes(c.state));
});

test('not logged into LeetCode: preflight pauses with a clear message', async () => {
  const lc = makeLeetcode(dataset()); lc.state.signedIn = false;
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'paused');
  assert.ok(/log into LeetCode/i.test(p.error));
  assert.strictEqual(w.github.stats.puts, 0);
});

/* ======================= sync current ======================= */
test('Sync Current: verified Accepted submission of the open tab problem is synced (no lastKnownStatus needed)', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc, tabUrl: 'https://leetcode.com/problems/two-sum/' });
  await w.configure();
  const r = (await w.call('SYNC_CURRENT')).data;
  assert.strictEqual(r.ok, true, r.message);
  assert.ok(/Easy\/0001-two-sum\/solution\.(py|cpp)/.test(r.record.githubPath));
  assert.ok(w.github.files.has('Easy/0001-two-sum/README.md'));
  assert.ok(w.github.files.has('README.md'));
});

test('Sync Current refuses when the problem has no Accepted submission', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc, tabUrl: 'https://leetcode.com/problems/longest-palindromic-substring/' });
  await w.configure();
  const r = (await w.call('SYNC_CURRENT')).data;
  assert.strictEqual(r.ok, false);
  assert.ok(/Refusing to sync/.test(r.message), r.message);
  assert.strictEqual(w.github.stats.puts, 0);
});

test('Sync Current with no LeetCode problem tab gives a helpful error; "sync by slug" works without one', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc, tabUrl: 'https://leetcode.com/problemset/' });
  await w.configure();
  const r = (await w.call('SYNC_CURRENT')).data;
  assert.strictEqual(r.ok, false); assert.ok(/problem page/i.test(r.message));
  const r2 = (await w.call('SYNC_PROBLEM', { slug: 'reverse-integer' })).data;
  assert.strictEqual(r2.ok, true, r2.message);
  assert.ok(w.github.files.has('Medium/0007-reverse-integer/solution.go'));
});

test('safety gate: syncSubmissionModel refuses any non-Accepted model, always', async () => {
  const w = createWorld({ leetcode: makeLeetcode(dataset()) });
  await w.configure();
  const base = { submissionId: '1', problemNumber: '1', title: 'T', slug: 't', difficulty: 'Easy', language: 'Python3', extension: 'py', code: 'x', topics: [] };
  for (const status of ['Wrong Answer', 'Time Limit Exceeded', 'Pending', 'Judging', 'Unknown Error', null, undefined, 'accepted', 'ACCEPTED ']) {
    await assert.rejects(() => w.LGS.sync.currentSync.syncSubmissionModel(Object.assign({}, base, { status })), /Refusing to sync/, String(status));
  }
  assert.strictEqual(w.github.stats.puts, 0);
  await assert.rejects(() => w.LGS.sync.currentSync.syncSubmissionModel(Object.assign({}, base, { status: 'Accepted', problemNumber: null })), /Refusing to sync/);
});

/* ======================= live auto-sync path ======================= */
test('auto-sync message: Accepted syncs, non-Accepted never does, untrusted sender ignored', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const problem = { number: '9', title: 'Palindrome Number', slug: 'palindrome-number', difficulty: 'Easy', tags: ['Math'] };
  const send = (payload, sender) => new Promise((res) => w.swSandbox.LGS.messageHandler.dispatch({ type: 'SUBMISSION_RESULT', payload }, sender, (r) => res(plain(r))));
  const ok = { id: 'test-ext', tab: { id: 1 } };
  const wa = await send({ submissionId: '1', status: 'Wrong Answer', problem, code: 'x', language: 'Python3' }, ok);
  assert.strictEqual(wa.data.synced, false);
  const bad = await send({ submissionId: '2', status: 'Accepted', problem, code: 'x', language: 'Python3' }, { id: 'someone-else' });
  assert.strictEqual(bad.data.synced, false);
  assert.strictEqual(w.github.stats.puts, 0);
  const good = await send({ submissionId: '3', status: 'Accepted', problem, code: 'print(1)', language: 'Python3' }, ok);
  assert.strictEqual(good.data.synced, true, JSON.stringify(good));
  assert.ok(w.github.files.has('Easy/0009-palindrome-number/solution.py'));
  const puts = w.github.stats.puts;
  const again = await send({ submissionId: '3', status: 'Accepted', problem, code: 'print(1)', language: 'Python3' }, ok);
  assert.strictEqual(w.github.stats.puts, puts, 'the same submission must not be written twice');
});

/* ======================= tools ======================= */
test('rebuild index from GitHub, regenerate README, verify coverage', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  await runHistorical(w);
  // simulate a fresh browser: local index gone, repo still has everything
  await w.LGS.storage.remove('solutionIndex');
  assert.strictEqual((await w.call('GET_INDEX')).data.stats.problems, 0);
  const rb = (await w.call('REBUILD_INDEX')).data;
  assert.strictEqual(rb.ok, true, rb.message);
  assert.strictEqual(rb.result.problems, 5);
  const cov = (await w.call('VERIFY_COVERAGE')).data;
  assert.strictEqual(cov.ok, true, cov.message);
  assert.strictEqual(cov.result.missing.length, 0);
  assert.strictEqual(cov.result.leetcodeSolved, 5);
  // delete one problem from the repo -> coverage shows it missing
  for (const k of Array.from(w.github.files.keys())) if (/valid-parentheses/.test(k)) w.github.files.delete(k);
  await w.LGS.storage.remove('solutionIndex');
  const cov2 = (await w.call('VERIFY_COVERAGE')).data;
  assert.deepStrictEqual(cov2.result.missing.map((m) => m.slug), ['valid-parentheses']);
  const rg = (await w.call('REGENERATE_READMES', { problemReadmes: true })).data;
  assert.strictEqual(rg.ok, true, rg.message);
});

test('diagnostics: reports pass/warn/fail per dependency and explains the null-status case', async () => {
  const lc = makeLeetcode(dataset()); lc.state.restMode = 'statusNull'; lc.state.gqlListMode = 'statusNull';
  const w = createWorld({ leetcode: lc });
  await w.configure();
  const rep = (await w.call('RUN_DIAGNOSTICS')).data;
  const by = Object.fromEntries(rep.checks.map((c) => [c.id, c]));
  assert.strictEqual(by['gh-conn'].status, 'pass');
  assert.strictEqual(by['lc-auth'].status, 'pass');
  assert.strictEqual(by['lc-rest'].status, 'warn'); assert.ok(/statusDisplay: null/.test(by['lc-rest'].hint));
  assert.strictEqual(by['lc-detail'].status, 'pass');
  assert.strictEqual(by['lc-stats'].status, 'pass');
  assert.strictEqual(rep.ok, true);
});

test('retry list: failures are classified; recoverable ones can be retried', async () => {
  const lc = makeLeetcode(dataset());
  const w = createWorld({ leetcode: lc });
  await w.configure();
  // make exactly one detail fetch fail with a transient server error, persistently for one slug
  const orig = lc.handle;
  lc.handle = async (u, i) => {
    if (i && i.body && /submissionDetails/.test(i.body) && String(JSON.parse(i.body).variables.submissionId) === '1010') {
      return { ok: false, status: 502, redirected: false, headers: { get: () => null }, text: async () => 'bad gateway' };
    }
    return orig(u, i);
  };
  const p = await runHistorical(w);
  assert.strictEqual(p.state, 'completed');
  assert.strictEqual(p.failed, 1);
  const failed = (await w.call('GET_FAILED_ITEMS')).data;
  assert.strictEqual(failed[0].category, 'server'); assert.strictEqual(failed[0].retryable, true);
  lc.handle = orig;
  const r = (await w.call('RETRY_FAILED', { mode: 'recoverable' })).data;
  assert.strictEqual(r.retried, 1);
  const p2 = await w.waitProgress(['completed', 'error'], 20000);
  assert.strictEqual(p2.state, 'completed');
  assert.strictEqual((await w.call('GET_FAILED_ITEMS')).data.length, 0);
  assert.strictEqual(paths(w).filter((x) => /solution\./.test(x)).length, 6);
});

test('settings are validated/clamped; token is never returned to the UI', async () => {
  const w = createWorld({ leetcode: makeLeetcode(dataset()) });
  await w.configure();
  const s = (await w.call('SAVE_SETTINGS', { historicalPageSize: 99999, duplicateHandling: 'nonsense', githubWriteDelayMs: -5 })).data.settings;
  assert.strictEqual(s.historicalPageSize, 100); assert.strictEqual(s.duplicateHandling, 'update'); assert.strictEqual(s.githubWriteDelayMs, 0);
  const st = (await w.call('GET_STATE')).data;
  assert.ok(!JSON.stringify(st).includes('github_pat_'));
  assert.strictEqual(st.githubConfig.hasToken, true);
  const saved = (await w.call('SAVE_GITHUB_CONFIG', { owner: 'me', repo: 'sols', branch: 'dev', token: '' })).data;
  assert.strictEqual(saved.config.branch, 'dev'); assert.strictEqual(saved.config.hasToken, true); // blank token keeps the old one
  const bad = await w.call('SAVE_GITHUB_CONFIG', { owner: '../x', repo: 'a b', branch: '', token: 'short' });
  assert.strictEqual(bad.ok, false);
});

test('logger redacts GitHub tokens and never logs source code', async () => {
  const w = createWorld();
  const L = w.LGS.logger;
  L.error('boom github_pat_ABCDEFGHIJKLMNOP1234567890 end', { token: 'x', code: 'secret()', other: 1 });
  const line = L.getBuffer().pop().message;
  assert.ok(!line.includes('ABCDEFGHIJ') && !line.includes('secret()'), line);
});

test('formatter: path sanitization blocks traversal; blob sha matches git', async () => {
  const w = createWorld();
  const F = w.LGS.formatter;
  assert.ok(!F.buildProblemFolder('Easy', 1, '../../etc/passwd').includes('..'));
  assert.strictEqual(F.buildProblemFolder('Easy', 1, 'two-sum'), 'Easy/0001-two-sum');
  assert.strictEqual(await F.gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.strictEqual(w.LGS.languages.resolveLanguage('C++').extension, 'cpp');
  assert.strictEqual(w.LGS.languages.resolveLanguage('MySQL').extension, 'mysql.sql');
  assert.strictEqual(w.LGS.languages.resolveLanguage('Brainf*ck').unknown, true);
});

require('./progress')(test);

/* ======================= runner ======================= */
(async () => {
  let pass = 0; const fails = [];
  for (const t of tests) {
    try { await t.fn(); pass++; console.log('  \u2713', t.name); }
    catch (e) { fails.push(t.name); console.log('  \u2717', t.name, '\n     ', (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${pass}/${tests.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
