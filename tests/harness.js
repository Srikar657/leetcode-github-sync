/**
 * Test harness: loads the REAL extension source files into two vm contexts
 * (service worker + a LeetCode tab content script) wired together with a
 * fake chrome.* message bus, a fake GitHub REST server and a configurable
 * fake LeetCode (REST + GraphQL) server.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function gitSha(text) {
  const body = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}

/* ---------------- fake storage ---------------- */
function makeStorage(initial) {
  const data = initial || {};
  return {
    data,
    local: {
      get(keys, cb) {
        const out = {};
        const list = keys == null ? Object.keys(data) : (Array.isArray(keys) ? keys : [keys]);
        list.forEach((k) => { if (k in data) out[k] = plain(data[k]); });
        setImmediate(() => cb(out));
      },
      set(items, cb) { Object.keys(items).forEach((k) => { data[k] = plain(items[k]); }); setImmediate(() => cb && cb()); },
      remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]); setImmediate(() => cb && cb()); }
    }
  };
}

/* ---------------- fake GitHub ---------------- */
function makeGithub(owner = 'me', repo = 'sols', branch = 'main') {
  const files = new Map();
  const stats = { puts: 0, gets: 0, treeGets: 0, putPaths: [] };
  const opts = { conflictOnce: new Set(), forbidPut: false, rateLimitPuts: 0, failPuts: 0 };
  const base = `/repos/${owner}/${repo}`;
  const res = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status, redirected: false,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  });
  async function handle(url, init) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const method = (init && init.method) || 'GET';
    if (p === '/rate_limit') return res(200, { resources: { core: { remaining: 4000, limit: 5000 } } });
    if (p === base) return res(200, { private: false, permissions: { push: true } });
    if (p === `${base}/branches/${branch}`) return res(200, { name: branch, commit: { commit: { tree: { sha: 'TREE' } } } });
    if (p === `${base}/git/trees/TREE`) {
      stats.treeGets++;
      return res(200, { truncated: false, tree: Array.from(files.entries()).map(([path, f]) => ({ path, type: 'blob', sha: f.sha })) });
    }
    if (p.startsWith(`${base}/contents/`)) {
      const fp = p.slice(`${base}/contents/`.length);
      if (method === 'GET') {
        stats.gets++;
        const f = files.get(fp);
        if (!f) return res(404, { message: 'Not Found' });
        return res(200, { sha: f.sha, path: fp, content: Buffer.from(f.content, 'utf8').toString('base64') });
      }
      if (method === 'PUT') {
        if (opts.failPuts > 0) { opts.failPuts--; return res(502, { message: 'Bad Gateway' }); }
        if (opts.forbidPut) return res(403, { message: 'Resource not accessible by personal access token' });
        if (opts.rateLimitPuts > 0) { opts.rateLimitPuts--; return res(403, { message: 'secondary rate limit' }, { 'retry-after': '1' }); }
        const body = JSON.parse(init.body);
        const existing = files.get(fp);
        if (opts.conflictOnce.has(fp)) {
          opts.conflictOnce.delete(fp);
          // someone else changed the file meanwhile
          files.set(fp, { content: 'changed by someone else\n', sha: gitSha('changed by someone else\n') });
          return res(409, { message: `${fp} does not match` });
        }
        if (existing && body.sha !== existing.sha) return res(existing && !body.sha ? 422 : 409, { message: existing && !body.sha ? '"sha" wasn\'t supplied.' : 'sha does not match' });
        const content = Buffer.from(body.content, 'base64').toString('utf8');
        const sha = gitSha(content);
        files.set(fp, { content, sha });
        stats.puts++; stats.putPaths.push(fp);
        return res(existing ? 200 : 201, { content: { path: fp, sha, html_url: `https://github.com/${owner}/${repo}/blob/${branch}/${fp}` } });
      }
    }
    return res(404, { message: 'Not Found' });
  }
  return { files, stats, opts, handle, owner, repo, branch };
}

/* ---------------- fake LeetCode ---------------- */
const CODE = (slug, lang) => `// ${slug} in ${lang}\nclass Solution {}\n`;

function makeLeetcode(submissions) {
  const state = {
    submissions,                // [{id,slug,title,lang,langName,code,statusCode,ts,number,difficulty,tags}]
    restMode: 'ok',             // ok | broken | statusNull
    gqlListMode: 'ok',          // ok | statusNull | nullAll | ignoreOffset
    pageCap: 100,               // server never returns more than this
    signedIn: true,
    detailHasStatus: true,
    failDetailAfter: null,      // number of detail calls before 403
    calls: { rest: 0, gql: 0, detail: 0, list: 0 },
    log: [],                    // every request: method + path
    statsMode: 'ok',            // 'ok' | 'broken' | 'lag' (returns the previous count)
    solvedStatus: undefined,    // override question.status ('ac' | 'notac' | 'error')
    username: 'tester'
  };
  const STATUS = { 10: 'Accepted', 11: 'Wrong Answer', 14: 'Time Limit Exceeded' };

  const respond = (status, body, extra = {}) => ({
    ok: status >= 200 && status < 300, status, redirected: false, url: '',
    headers: { get: (k) => (extra[k.toLowerCase()] || null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  });

  function pageOf(list, offset, limit) {
    const n = Math.min(limit, state.pageCap);
    const slice = list.slice(offset, offset + n);
    return { slice, hasNext: offset + n < list.length };
  }
  const sorted = (slug) => state.submissions.filter((s) => !slug || s.slug === slug).sort((a, b) => b.ts - a.ts);

  function restItem(s) {
    return {
      id: s.id, title: s.title, title_slug: s.slug, lang: s.lang, timestamp: s.ts, runtime: '5 ms', memory: '17 MB',
      status_display: state.restMode === 'statusNull' ? null : STATUS[s.statusCode], url: `/submissions/detail/${s.id}/`, is_pending: 'Not Pending'
    };
  }
  function gqlItem(s) {
    return {
      id: String(s.id), title: s.title, titleSlug: s.slug, lang: s.lang, langName: s.langName, timestamp: String(s.ts), runtime: '5 ms', memory: '17 MB',
      status: null, statusDisplay: state.gqlListMode === 'statusNull' ? null : STATUS[s.statusCode], url: `/submissions/detail/${s.id}/`, isPending: false
    };
  }

  async function handle(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    state.log.push(`${method} ${u.pathname}`);
    if (!state.signedIn) return respond(403, { detail: 'Authentication credentials were not provided.' });

    if (/^\/submissions\/detail\/\d+\/check\/$/.test(u.pathname)) {
      const sub = state.submissions.find((x) => String(x.id) === u.pathname.split('/')[3]);
      if (!sub) return respond(404, 'nope');
      return respond(200, { state: 'SUCCESS', status_code: sub.statusCode, status_msg: STATUS[sub.statusCode] });
    }
    if (u.pathname.startsWith('/api/submissions/')) {
      state.calls.rest++;
      if (state.restMode === 'broken') return respond(404, '<html>Not found</html>');
      const rest = u.pathname.slice('/api/submissions/'.length).replace(/\/$/, '');
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 20);
      const { slice, hasNext } = pageOf(sorted(rest || null), offset, limit);
      return respond(200, { submissions_dump: slice.map(restItem), has_next: hasNext, last_key: hasNext ? `k${offset}` : '' });
    }

    if (u.pathname.startsWith('/graphql')) {
      state.calls.gql++;
      const { query, variables } = JSON.parse(init.body);
      const gqlErr = (m) => respond(200, { errors: [{ message: m }] });
      if (/questionStatus/.test(query)) {
        if (state.solvedStatus === 'error') return gqlErr('Cannot query field "status" on type "QuestionNode".');
        const any = state.submissions.some((x) => x.slug === variables.titleSlug && x.statusCode === 10);
        return respond(200, { data: { question: { status: state.solvedStatus !== undefined ? state.solvedStatus : (any ? 'ac' : 'notac') } } });
      }
      if (/globalData/.test(query)) return respond(200, { data: { userStatus: { isSignedIn: true, username: state.username } } });
      if (/userStats/.test(query)) {
        if (state.statsMode === 'broken') return gqlErr('Cannot query field "matchedUser"');
        const solved = new Set(state.submissions.filter((s) => s.statusCode === 10).map((s) => s.slug));
        if (state.statsMode === 'lag') solved.delete(state.submissions[state.submissions.length - 1].slug);
        const d = { Easy: 0, Medium: 0, Hard: 0 };
        solved.forEach((slug) => { d[state.submissions.find((s) => s.slug === slug).difficulty]++; });
        return respond(200, { data: { matchedUser: { submitStats: { acSubmissionNum: [
          { difficulty: 'All', count: solved.size }, { difficulty: 'Easy', count: d.Easy }, { difficulty: 'Medium', count: d.Medium }, { difficulty: 'Hard', count: d.Hard }] } } } });
      }
      if (/problemsetQuestionListV2/.test(query)) return gqlErr('Cannot query field "problemsetQuestionListV2" on type "Query".');
      if (/problemsetQuestionList/.test(query)) {
        const solved = new Map();
        state.submissions.filter((s) => s.statusCode === 10).forEach((s) => solved.set(s.slug, s));
        const all = Array.from(solved.values()).sort((a, b) => a.number - b.number);
        const skip = variables.skip || 0; const limit = variables.limit || 50;
        return respond(200, { data: { problemsetQuestionList: { total: all.length, questions: all.slice(skip, skip + limit).map((s) => ({
          questionFrontendId: String(s.number), title: s.title, titleSlug: s.slug, difficulty: s.difficulty, status: 'ac', topicTags: s.tags.map((name) => ({ name })) })) } } });
      }
      if (/submissionList/.test(query)) {
        state.calls.list++;
        if (state.gqlListMode === 'nullAll') return respond(200, { data: { submissionList: null } });
        if (/statusCode|isPending: Boolean/.test(query)) return gqlErr('Cannot query field');
        const slug = variables.questionSlug || null;
        const offset = state.gqlListMode === 'ignoreOffset' ? 0 : variables.offset;
        const { slice, hasNext } = pageOf(sorted(slug), offset, variables.limit);
        return respond(200, { data: { submissionList: { lastKey: hasNext ? `k${offset}` : null, hasNext, submissions: slice.map(gqlItem) } } });
      }
      if (/submissionDetails/.test(query)) {
        state.calls.detail++;
        if (state.failDetailAfter != null && state.calls.detail > state.failDetailAfter) return respond(403, '<html>forbidden</html>');
        // Variant sensitivity: the first (richest) variant is rejected to prove fallback works.
        if (/runtimeDisplay/.test(query)) return gqlErr('Cannot query field "runtimeDisplay" on type "SubmissionDetailNode".');
        if (/ID!|String!/.test(query)) return gqlErr('Variable "$submissionId" of type "ID!" used in position expecting type "Int!".');
        const s = state.submissions.find((x) => String(x.id) === String(variables.submissionId));
        if (!s) return respond(200, { data: { submissionDetails: null } });
        const d = { runtime: 5, memory: 17500000, code: s.code, timestamp: s.ts, lang: { name: s.lang, verboseName: s.langName },
          question: { questionId: String(s.number + 1000), titleSlug: s.slug, title: s.title, difficulty: s.difficulty, topicTags: s.tags.map((name) => ({ name })) } };
        if (/questionFrontendId/.test(query)) d.question.questionFrontendId = String(s.number);
        if (/statusCode/.test(query) && state.detailHasStatus) d.statusCode = s.statusCode;
        return respond(200, { data: { submissionDetails: d } });
      }
      if (/questionMeta/.test(query)) {
        const s = state.submissions.find((x) => x.slug === variables.titleSlug);
        return respond(200, { data: { question: s ? { questionId: String(s.number + 1000), questionFrontendId: String(s.number), title: s.title, titleSlug: s.slug, difficulty: s.difficulty, topicTags: s.tags.map((name) => ({ name })) } : null } });
      }
      return gqlErr('Unknown query');
    }
    return respond(404, 'nope');
  }
  return { state, handle };
}

/* ---------------- world ---------------- */
function loadFiles(ctx, files) {
  for (const f of files) {
    const full = path.join(ROOT, f);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: f });
  }
}

const SW_FILES = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8')
  .match(/importScripts\(([\s\S]*?)\);/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1))
  .map((rel) => path.posix.normalize(path.posix.join('src/background', rel)));
const CS_FILES = manifest.content_scripts[0].js;

function createWorld(opts = {}) {
  const storage = opts.storage || makeStorage();
  // The content script announces itself on load, which (correctly) triggers a quiet background stats
  // import. Tests that are not about that start with a fresh stats cache so numbers stay deterministic.
  if (!opts.autoRefresh && !storage.data.statsMeta) storage.data.statsMeta = { lastRefreshAt: Date.now() };
  const github = opts.github || makeGithub();
  const leetcode = opts.leetcode;
  const alarms = [];
  const notifications = [];
  const swListeners = [];
  const csListeners = [];
  const tab = { id: 7, url: opts.tabUrl || 'https://leetcode.com/problems/two-sum/', active: true, windowId: 1, status: 'complete', lastAccessed: Date.now() };
  const tabsState = { list: opts.noTab ? [] : [tab], created: [], removed: [] };

  function makeChrome(listeners, isSW) {
    return {
      runtime: {
        id: 'test-ext', lastError: undefined,
        getManifest: () => manifest,
        getURL: (p) => `chrome-extension://test/${p}`,
        getPlatformInfo: (cb) => cb && cb({}),
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage(msg, cb) {
          if (isSW) { if (cb) cb(); return; } // broadcast to UI: nobody listening
          // content script -> SW
          const sender = { id: 'test-ext', tab: { id: tab.id } };
          for (const l of swListeners) if (l(msg, sender, (r) => cb && cb(r))) return;
          if (cb) cb();
        }
      },
      storage: { local: storage.local, onChanged: { addListener() {} } },
      alarms: { create: (n, i) => alarms.push({ n, i }), clear: (n) => { for (let i = alarms.length - 1; i >= 0; i--) if (alarms[i].n === n) alarms.splice(i, 1); }, onAlarm: { addListener() {} } },
      notifications: { create: (o) => notifications.push(o) },
      scripting: { executeScript: async () => [] },
      windows: { getLastFocused: (cb) => cb({ id: 1 }) },
      tabs: {
        query: (q, cb) => cb(plain(tabsState.list.filter((t) => !q.url || new RegExp('^' + q.url.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$').test(t.url)))),
        create: (o, cb) => { const t = { id: 100 + tabsState.created.length, url: o.url, active: false, windowId: 1, status: 'complete' }; tabsState.created.push(t); tabsState.list.push(t); cb(t); },
        remove: (id, cb) => { tabsState.removed.push(id); tabsState.list = tabsState.list.filter((t) => t.id !== id); cb && cb(); },
        get: (id, cb) => cb(tabsState.list.find((t) => t.id === id)),
        onUpdated: { addListener() {}, removeListener() {} },
        sendMessage(id, msg, cb) {
          if (!tabsState.list.some((t) => t.id === id)) { chrome_sw.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }; setImmediate(() => { cb(undefined); chrome_sw.runtime.lastError = undefined; }); return; }
          let answered = false;
          const send = (r) => { if (answered) return; answered = true; setImmediate(() => cb(plain(r))); };
          let async = false;
          for (const l of csListeners) { if (l(plain(msg), { id: 'test-ext' }, send)) { async = true; break; } }
          if (!async && !answered) send(undefined);
        }
      }
    };
  }

  const chrome_sw = makeChrome(swListeners, true);
  const chrome_cs = makeChrome(csListeners, false);
  const common = { TextEncoder, TextDecoder, btoa, atob, crypto: crypto.webcrypto, URL, AbortController, setTimeout, clearTimeout, Promise };

  /* ---- service worker context ---- */
  const swSandbox = Object.assign({}, common, {
    chrome: chrome_sw,
    console: { log() {}, info() {}, debug() {}, warn() { if (opts.verbose) console.warn(...arguments); }, error() { if (opts.verbose) console.error(...arguments); } },
    setInterval: () => 0, clearInterval() {},
    fetch: async (url, init) => github.handle(url, init)
  });
  swSandbox.self = swSandbox;
  const sw = vm.createContext(swSandbox);
  swSandbox.importScripts = () => {};
  chrome_sw.alarms.onAlarm.addListener = () => {};
  loadFiles(sw, SW_FILES.filter((f) => !f.endsWith('service-worker.js')));
  // register the listener the real service-worker.js registers
  swListeners.push((message, sender, sendResponse) => swSandbox.LGS.messageHandler.dispatch(message, sender, sendResponse));
  swSandbox.LGS.CONST.RETRY_BASE_DELAY_MS = 1;
  swSandbox.LGS.CONST.MAX_INLINE_WAIT_MS = opts.maxInlineWaitMs || 90000;

  /* ---- content script context ---- */
  let cs = null;
  if (leetcode) {
    const csSandbox = Object.assign({}, common, {
      chrome: chrome_cs,
      console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
      setInterval: () => 0, clearInterval() {},
      document: { cookie: 'csrftoken=abc123', querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
      location: { pathname: `/problems/${opts.slug || 'two-sum'}/`, href: `https://leetcode.com/problems/${opts.slug || 'two-sum'}/`, origin: 'https://leetcode.com' },
      addEventListener() {}, postMessage() {},
      fetch: async (url, init) => leetcode.handle(url, init)
    });
    csSandbox.self = csSandbox; csSandbox.window = csSandbox;
    cs = vm.createContext(csSandbox);
    loadFiles(cs, CS_FILES);
  }

  function call(type, payload) {
    return new Promise((resolve) => {
      const sender = { id: 'test-ext', tab: { id: tab.id } };
      swListeners[0]({ type, payload }, sender, (r) => resolve(plain(r)));
    });
  }

  async function waitFor(pred, { timeout = 15000, interval = 10 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await pred();
      if (v) return v;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('waitFor timed out');
  }

  async function waitProgress(states, timeout) {
    return waitFor(async () => {
      const p = plain(await swSandbox.LGS.sync.historicalSync.getProgress());
      return states.includes(p.state) ? p : null;
    }, { timeout });
  }

  async function configure(settings) {
    await call('SAVE_GITHUB_CONFIG', { owner: github.owner, repo: github.repo, branch: github.branch, token: 'github_pat_0123456789abcdef' });
    await call('SAVE_SETTINGS', Object.assign({ leetcodeRequestDelayMs: 0, githubWriteDelayMs: 0, notifications: false }, settings || {}));
  }

  return { LGS: swSandbox.LGS, csLGS: cs && csSandbox_LGS(cs), storage, github, leetcode, alarms, notifications, tabsState, call, waitFor, waitProgress, configure, swSandbox, plain };
}
function csSandbox_LGS(ctx) { return vm.runInContext('LGS', ctx); }

/* ---------------- dataset ---------------- */
function dataset() {
  let id = 1000; let ts = 1700000000;
  const rows = [];
  const add = (slug, number, title, difficulty, lang, langName, statusCode, tags = ['Array']) => {
    rows.push({ id: ++id, slug, number, title, difficulty, lang, langName, statusCode, ts: ts += 100, tags, code: CODE(slug, lang) + `// run ${id}` });
  };
  add('two-sum', 1, 'Two Sum', 'Easy', 'python3', 'Python3', 11);
  add('two-sum', 1, 'Two Sum', 'Easy', 'python3', 'Python3', 10, ['Array', 'Hash Table']);
  add('two-sum', 1, 'Two Sum', 'Easy', 'cpp', 'C++', 10, ['Array', 'Hash Table']);
  add('add-two-numbers', 2, 'Add Two Numbers', 'Medium', 'java', 'Java', 14);
  add('add-two-numbers', 2, 'Add Two Numbers', 'Medium', 'java', 'Java', 10, ['Linked List']);
  add('add-two-numbers', 2, 'Add Two Numbers', 'Medium', 'java', 'Java', 10, ['Linked List']); // later accepted -> "latest"
  add('median-of-two-sorted-arrays', 4, 'Median of Two Sorted Arrays', 'Hard', 'python3', 'Python3', 10, ['Binary Search']);
  add('longest-palindromic-substring', 5, 'Longest Palindromic Substring', 'Medium', 'python3', 'Python3', 11); // never accepted
  add('reverse-integer', 7, 'Reverse Integer', 'Medium', 'golang', 'Go', 10, ['Math']);
  add('valid-parentheses', 20, 'Valid Parentheses', 'Easy', 'rust', 'Rust', 10, ['Stack']);
  return rows;
}

module.exports = { createWorld, makeLeetcode, makeGithub, makeStorage, dataset, plain, gitSha, CODE };
