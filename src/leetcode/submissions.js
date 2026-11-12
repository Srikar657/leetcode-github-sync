/**
 * submissions.js  (src/leetcode/)
 *
 * Every submission-related LeetCode call lives here, behind a small API,
 * so a LeetCode change only ever needs a fix in this file.
 *
 * LeetCode's endpoints are internal and not a stable public contract, so
 * this module is defensive in four ways (review items 1, 2, 4, 5, 6):
 *
 *  1. TWO list sources - the REST /api/submissions/ endpoint and the
 *     GraphQL `submissionList` - with automatic fallback between them.
 *  2. QUERY VARIANTS - each GraphQL operation has several field sets; if
 *     LeetCode rejects one (validation error), the next is tried, and the
 *     working one is remembered.
 *  3. NORMALIZATION - every list/detail item is converted to one shape.
 *     A missing/null status is `statusHint: null` ("unknown"), never
 *     "Unknown Error".
 *  4. SOLVED LIST - the account's own solved-problem list gives an
 *     independent, authoritative checklist to compare against.
 *
 * Runs in the LeetCode content-script context.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { graphql } = LGS.leetcode;
  const status = LGS.leetcode.status;
  const E = LGS.errors;
  const { ACCEPTED_STATUS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } = LGS.CONST;

  /* ------------------------------------------------------------------ *
   * Variant runner
   * ------------------------------------------------------------------ */
  const variantMemo = {};

  async function runVariants(name, variants, baseVars, operationName) {
    const start = variantMemo[name] || 0;
    let lastErr = null;
    for (let n = 0; n < variants.length; n++) {
      const i = (start + n) % variants.length;
      const v = variants[i];
      try {
        const data = await graphql.query(v.query, v.vars ? v.vars(baseVars) : baseVars, v.op || operationName);
        variantMemo[name] = i;
        return { data, variant: i };
      } catch (err) {
        if (err && err.code === 'LEETCODE_GRAPHQL_ERROR' && err.isValidation) { lastErr = err; continue; }
        throw err;
      }
    }
    throw E.makeError(
      'LEETCODE_SCHEMA_ERROR',
      `LeetCode rejected every known version of the "${name}" query (${lastErr ? lastErr.message : 'no detail'}). LeetCode has probably changed its API - run Diagnostics.`,
      { cause: lastErr }
    );
  }

  /* ------------------------------------------------------------------ *
   * Small normalizers
   * ------------------------------------------------------------------ */
  function toSeconds(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }

  function formatRuntime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return `${v} ms`;
    return String(v);
  }

  function formatMemory(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 100000 ? `${(v / 1048576).toFixed(1)} MB` : `${v} MB`;
    return String(v);
  }

  function slugFromAny(raw) {
    if (raw.titleSlug) return raw.titleSlug;
    if (raw.title_slug) return raw.title_slug;
    if (raw.questionSlug) return raw.questionSlug;
    return null;
  }

  function normalizeListItem(raw, source) {
    const st = status.fromSubmissionRecord(raw);
    return {
      id: raw.id != null ? String(raw.id) : null,
      title: raw.title || '',
      titleSlug: slugFromAny(raw),
      lang: typeof raw.lang === 'string' ? raw.lang : (raw.langSlug || ''),
      langName: raw.langName || raw.lang_name || '',
      timestamp: toSeconds(raw.timestamp != null ? raw.timestamp : raw.time_stamp),
      runtime: raw.runtime != null ? String(raw.runtime) : null,
      memory: raw.memory != null ? String(raw.memory) : null,
      statusHint: st.status,
      statusSource: st.source,
      isPending: st.status === LGS.CONST.LEETCODE_STATUS.PENDING || st.status === LGS.CONST.LEETCODE_STATUS.JUDGING,
      source
    };
  }

  /** Counts how many raw items carry each status-ish field (for Diagnostics). */
  function summarizeFields(rawItems) {
    const keys = ['statusDisplay', 'status_display', 'status', 'statusCode', 'status_code', 'status_msg'];
    const summary = { sampleKeys: rawItems[0] ? Object.keys(rawItems[0]).sort() : [], present: {} };
    for (const k of keys) {
      const n = rawItems.filter((r) => r && r[k] != null && r[k] !== '').length;
      if (n) summary.present[k] = `${n}/${rawItems.length}`;
    }
    return summary;
  }

  /* ------------------------------------------------------------------ *
   * Submission LIST (REST + GraphQL)
   * ------------------------------------------------------------------ */
  const LIST_FIELDS_FULL = 'id title titleSlug status statusDisplay lang langName timestamp runtime memory url isPending';
  const LIST_FIELDS_MIN = 'id title titleSlug status statusDisplay lang timestamp';
  const LIST_FIELDS_TINY = 'id title titleSlug statusDisplay lang timestamp';

  function listQuery(fields, argDecl) {
    const decl = argDecl || '$questionSlug: String';
    return `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, ${decl}) {
      submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
        lastKey hasNext submissions { ${fields} }
      }
    }`;
  }
  function listQueryNoSlug(fields) {
    return `query submissionList($offset: Int!, $limit: Int!, $lastKey: String) {
      submissionList(offset: $offset, limit: $limit, lastKey: $lastKey) {
        lastKey hasNext submissions { ${fields} }
      }
    }`;
  }

  const LIST_VARIANTS_GLOBAL = [
    { query: listQuery(LIST_FIELDS_FULL) },
    { query: listQuery(LIST_FIELDS_MIN) },
    { query: listQueryNoSlug(LIST_FIELDS_FULL) },
    { query: listQueryNoSlug(LIST_FIELDS_TINY) }
  ];
  const LIST_VARIANTS_SLUG = [
    { query: listQuery(LIST_FIELDS_FULL) },
    { query: listQuery(LIST_FIELDS_MIN) },
    { query: listQuery(LIST_FIELDS_FULL, '$questionSlug: String!') },
    { query: listQuery(LIST_FIELDS_TINY, '$questionSlug: String!') }
  ];

  async function listPageGraphql({ offset, limit, lastKey, slug }) {
    const base = { offset, limit, lastKey: lastKey || null, questionSlug: slug || null };
    const { data } = await runVariants(slug ? 'submissionListSlug' : 'submissionListGlobal',
      slug ? LIST_VARIANTS_SLUG : LIST_VARIANTS_GLOBAL, base, 'submissionList');
    const list = data && data.submissionList;
    const raw = (list && list.submissions) || [];
    return {
      submissions: raw.map((r) => normalizeListItem(r, 'graphql')),
      hasNext: !!(list && list.hasNext),
      lastKey: (list && list.lastKey) || null,
      source: 'graphql',
      rawCount: raw.length,
      nullData: !list,
      fields: summarizeFields(raw)
    };
  }

  async function listPageRest({ offset, limit, lastKey, slug }) {
    const qs = `offset=${offset}&limit=${limit}&lastkey=${encodeURIComponent(lastKey || '')}`;
    const path = slug ? `/api/submissions/${encodeURIComponent(slug)}/?${qs}` : `/api/submissions/?${qs}`;
    const json = await graphql.restGet(path);
    const raw = (json && (json.submissions_dump || json.submissions)) || [];
    if (!Array.isArray(raw)) throw E.makeError('LEETCODE_BAD_RESPONSE', 'Unexpected /api/submissions/ response shape.');
    const hasNextRaw = json && (json.has_next != null ? json.has_next : json.hasNext);
    return {
      submissions: raw.map((r) => normalizeListItem(r, 'rest')),
      hasNext: hasNextRaw != null ? !!hasNextRaw : raw.length >= limit,
      lastKey: (json && (json.last_key || json.lastKey)) || null,
      source: 'rest',
      rawCount: raw.length,
      fields: summarizeFields(raw)
    };
  }

  const FALLBACK_CODES = new Set(['LEETCODE_SCHEMA_ERROR', 'LEETCODE_BAD_RESPONSE', 'LEETCODE_HTTP_ERROR', 'LEETCODE_GRAPHQL_ERROR']);

  /**
   * One page of submissions (global, or for a single problem when `slug`
   * is given). `source` pins REST / GraphQL; 'auto' tries REST first and
   * falls back to GraphQL on schema-ish failures or an empty first page.
   * The caller must keep using the `source` the page reports so that
   * offsets / lastKey stay consistent.
   */
  async function listPage({ offset = 0, limit = 20, lastKey = null, slug = null, source = 'auto' } = {}) {
    const order = source === 'rest' ? ['rest'] : source === 'graphql' ? ['graphql'] : ['rest', 'graphql'];
    let lastErr = null;
    let emptyFirst = null;
    for (let i = 0; i < order.length; i++) {
      const src = order[i];
      try {
        const args = { offset, limit, lastKey, slug };
        const page = src === 'rest' ? await listPageRest(args) : await listPageGraphql(args);
        const hasMore = i < order.length - 1;
        if (hasMore && offset === 0 && page.rawCount === 0) { emptyFirst = page; continue; }
        return page;
      } catch (err) {
        if (!(err && FALLBACK_CODES.has(err.code)) || i === order.length - 1) {
          if (emptyFirst && !(err && ['LEETCODE_NOT_AUTHENTICATED', 'LEETCODE_BLOCKED', 'LEETCODE_RATE_LIMITED'].includes(err.code))) return emptyFirst;
          throw err;
        }
        lastErr = err;
      }
    }
    if (emptyFirst) return emptyFirst;
    throw lastErr || E.makeError('LEETCODE_SCHEMA_ERROR', 'No submission list source worked.');
  }

  /** All (or up to maxPages pages of) submissions for one problem, newest first. */
  async function listForSlug(slug, { limit = 20, maxPages = 5, source = 'auto' } = {}) {
    const all = [];
    let offset = 0;
    let lastKey = null;
    let src = source;
    for (let page = 0; page < maxPages; page++) {
      const res = await listPage({ offset, limit, lastKey, slug, source: src });
      src = res.source;
      all.push(...res.submissions);
      if (!res.hasNext || res.rawCount === 0) break;
      offset += res.rawCount;
      lastKey = res.lastKey;
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all;
  }

  /* ------------------------------------------------------------------ *
   * Submission DETAIL (authoritative status + exact code)
   * ------------------------------------------------------------------ */
  const DETAIL_FIELDS = [
    'runtime runtimeDisplay memory memoryDisplay code timestamp statusCode lang { name verboseName } question { questionId questionFrontendId title titleSlug difficulty topicTags { name } }',
    'runtime memory code timestamp statusCode lang { name verboseName } question { questionId title titleSlug difficulty topicTags { name } }',
    'runtime memory code timestamp lang { name verboseName } question { titleSlug }'
  ];

  const DETAIL_VARIANTS = [];
  for (const type of ['Int!', 'ID!', 'String!']) {
    DETAIL_FIELDS.forEach((fields) => {
      DETAIL_VARIANTS.push({
        query: `query submissionDetails($submissionId: ${type}) { submissionDetails(submissionId: $submissionId) { ${fields} } }`,
        vars: (b) => ({ submissionId: type === 'Int!' ? Number(b.submissionId) : String(b.submissionId) })
      });
    });
  }

  function normalizeDetail(raw, id) {
    if (!raw) return null;
    const st = status.fromSubmissionRecord(raw);
    const q = raw.question || null;
    return {
      id: id != null ? String(id) : null,
      code: typeof raw.code === 'string' ? raw.code : '',
      status: st.status,
      statusSource: st.source,
      statusCode: raw.statusCode != null ? raw.statusCode : null,
      runtime: formatRuntime(raw.runtimeDisplay != null ? raw.runtimeDisplay : raw.runtime),
      memory: formatMemory(raw.memoryDisplay != null ? raw.memoryDisplay : raw.memory),
      timestamp: toSeconds(raw.timestamp),
      langName: raw.lang ? (raw.lang.verboseName || raw.lang.name || '') : '',
      langSlug: raw.lang ? (raw.lang.name || '') : '',
      question: q ? {
        id: q.questionId || null,
        frontendId: q.questionFrontendId || null,
        title: q.title || null,
        titleSlug: q.titleSlug || null,
        difficulty: q.difficulty || null,
        topicTags: Array.isArray(q.topicTags) ? q.topicTags.map((t) => t && t.name).filter(Boolean) : []
      } : null
    };
  }

  async function getDetail(submissionId) {
    const { data } = await runVariants('submissionDetails', DETAIL_VARIANTS, { submissionId }, 'submissionDetails');
    return normalizeDetail(data && data.submissionDetails, submissionId);
  }

  /* ------------------------------------------------------------------ *
   * Problem metadata, user status, solved list
   * ------------------------------------------------------------------ */
  const questionCache = new Map();

  const QUESTION_VARIANTS = [
    { query: 'query questionMeta($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug difficulty topicTags { name } } }' },
    { query: 'query questionMeta($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug difficulty } }' },
    { query: 'query questionMeta($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId title titleSlug difficulty } }' }
  ];

  async function getQuestionMeta(titleSlug) {
    if (!titleSlug) return null;
    if (questionCache.has(titleSlug)) return questionCache.get(titleSlug);
    const { data } = await runVariants('questionMeta', QUESTION_VARIANTS, { titleSlug }, 'questionMeta');
    const q = data && data.question;
    const meta = q ? {
      number: q.questionFrontendId || null,
      id: q.questionId || null,
      title: q.title || null,
      slug: q.titleSlug || titleSlug,
      difficulty: q.difficulty || null,
      tags: Array.isArray(q.topicTags) ? q.topicTags.map((t) => t && t.name).filter(Boolean) : []
    } : null;
    if (meta) questionCache.set(titleSlug, meta);
    return meta;
  }

  /**
   * LeetCode's OWN solved state for a problem: question.status is "ac" once
   * the problem is solved. Returns 'solved' | 'not-solved' | 'unknown'
   * ('unknown' = the field could not be read; the Accepted submission detail
   * is then the only evidence, which is itself LeetCode's verdict).
   */
  async function getProblemSolvedState(titleSlug) {
    try {
      const { data } = await runVariants('questionStatus', [
        { query: 'query questionStatus($titleSlug: String!) { question(titleSlug: $titleSlug) { status } }' }
      ], { titleSlug }, 'questionStatus');
      const q = data && data.question;
      if (!q) return 'unknown';
      const st = q.status == null ? null : String(q.status).toLowerCase();
      return st === 'ac' ? 'solved' : 'not-solved';
    } catch (err) {
      if (err.code === 'LEETCODE_NOT_AUTHENTICATED' || err.code === 'LEETCODE_BLOCKED') throw err;
      return 'unknown';
    }
  }

  /** Merge submissionDetails.question with question(titleSlug) so number/difficulty are never missing. */
  async function completeQuestionMeta(detailQuestion, slug) {
    const q = detailQuestion || {};
    let number = q.frontendId || null;
    let difficulty = q.difficulty || null;
    let title = q.title || null;
    let tags = q.topicTags || [];
    const theSlug = q.titleSlug || slug;
    if ((!number || !difficulty || !title) && theSlug) {
      try {
        const meta = await getQuestionMeta(theSlug);
        if (meta) {
          number = number || meta.number;
          difficulty = difficulty || meta.difficulty;
          title = title || meta.title;
          if (!tags.length) tags = meta.tags;
        }
      } catch (err) {
        if (err.code === 'LEETCODE_NOT_AUTHENTICATED' || err.code === 'LEETCODE_BLOCKED') throw err;
        LGS.logger.warn('Could not complete problem metadata for', theSlug, err.message);
      }
    }
    return { number, difficulty, title, slug: theSlug, tags };
  }

  async function getUserStatus() {
    const variants = [
      { query: 'query globalData { userStatus { isSignedIn username } }' },
      { query: 'query globalData { userStatus { isSignedIn } }' }
    ];
    try {
      const { data } = await runVariants('userStatus', variants, {}, 'globalData');
      const u = data && data.userStatus;
      if (u) return { isSignedIn: !!u.isSignedIn, username: u.username || null };
    } catch (err) {
      if (err.code === 'LEETCODE_NOT_AUTHENTICATED' || err.code === 'LEETCODE_BLOCKED') throw err;
      LGS.logger.debug('globalData query failed, falling back to REST auth probe:', err.message);
    }
    // Fallback: an authenticated REST call either works or says 403.
    await graphql.restGet('/api/submissions/?offset=0&limit=1&lastkey=');
    return { isSignedIn: true, username: null };
  }

  /** Verified solved counts straight from LeetCode (review item 23). */
  async function getSolvedStats() {
    const user = await getUserStatus();
    if (!user.isSignedIn) throw E.makeError('LEETCODE_NOT_AUTHENTICATED', 'You are not logged into LeetCode.');
    if (!user.username) return null;
    const { data } = await runVariants('solvedStats', [{
      query: 'query userStats($username: String!) { matchedUser(username: $username) { submitStats { acSubmissionNum { difficulty count } } } }'
    }], { username: user.username }, 'userStats');
    const rows = data && data.matchedUser && data.matchedUser.submitStats && data.matchedUser.submitStats.acSubmissionNum;
    if (!Array.isArray(rows)) return null;
    const by = {};
    rows.forEach((r) => { by[String(r.difficulty).toLowerCase()] = Number(r.count) || 0; });
    return { all: by.all || 0, easy: by.easy || 0, medium: by.medium || 0, hard: by.hard || 0, username: user.username };
  }

  const SOLVED_VARIANTS = [
    {
      kind: 'v1',
      op: 'problemsetQuestionList',
      query: `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
        problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
          total: totalNum
          questions: data { questionFrontendId title titleSlug difficulty status topicTags { name } }
        }
      }`,
      vars: (b) => ({ categorySlug: '', limit: b.limit, skip: b.skip, filters: { status: 'AC' } })
    },
    {
      kind: 'v2',
      op: 'problemsetQuestionListV2',
      query: `query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $searchKeyword: String, $skip: Int, $sortBy: QuestionSortByInput, $categorySlug: String) {
        problemsetQuestionListV2(filters: $filters, limit: $limit, searchKeyword: $searchKeyword, skip: $skip, sortBy: $sortBy, categorySlug: $categorySlug) {
          questions { titleSlug title questionFrontendId difficulty status topicTags { name } }
          totalLength
          hasMore
        }
      }`,
      vars: (b) => ({
        categorySlug: 'all-code-essentials', limit: b.limit, skip: b.skip, searchKeyword: '',
        filters: { filterCombineType: 'ALL', statusFilter: { questionStatuses: ['SOLVED'], operator: 'IS' } },
        sortBy: { sortField: 'CUSTOM', sortOrder: 'ASCENDING' }
      })
    }
  ];

  function isSolvedStatus(s) {
    if (s == null) return true; // field absent: trust the server-side filter
    const k = String(s).toLowerCase();
    return k === 'ac' || k === 'solved' || k === 'accepted';
  }

  /** The account's solved problems: [{slug, number, title, difficulty, topics}]. */
  async function listSolved({ pageSize = 100, maxPages = 100 } = {}) {
    const items = [];
    let skip = 0;
    let total = null;
    for (let page = 0; page < maxPages; page++) {
      const { data, variant } = await runVariants('solvedList', SOLVED_VARIANTS, { limit: pageSize, skip });
      const kind = SOLVED_VARIANTS[variant].kind;
      const block = kind === 'v1' ? data && data.problemsetQuestionList : data && data.problemsetQuestionListV2;
      const questions = (block && block.questions) || [];
      total = kind === 'v1' ? (block && block.total) : (block && block.totalLength);
      for (const q of questions) {
        if (!isSolvedStatus(q.status) || !q.titleSlug) continue;
        items.push({
          slug: q.titleSlug,
          number: q.questionFrontendId || null,
          title: q.title || null,
          difficulty: q.difficulty || null,
          topics: Array.isArray(q.topicTags) ? q.topicTags.map((t) => t && t.name).filter(Boolean) : []
        });
      }
      skip += questions.length;
      const more = kind === 'v1' ? (total != null && skip < total) : !!(block && block.hasMore);
      if (!questions.length || !more) break;
    }
    // de-duplicate by slug
    const seen = new Set();
    const unique = items.filter((i) => (seen.has(i.slug) ? false : (seen.add(i.slug), true)));
    return { total: total != null ? Number(total) : unique.length, items: unique };
  }

  /* ------------------------------------------------------------------ *
   * Current-problem resolution (review items 3, 17, 18)
   * ------------------------------------------------------------------ */

  /**
   * Finds the newest VERIFIED Accepted submission for a problem and returns
   * everything the background needs to sync it - no dependence on what the
   * page happened to show, on `lastKnownStatus`, or on DOM scraping.
   */
  async function resolveProblem(slug, { preferLangSlug = null, maxChecks = 10 } = {}) {
    let meta = null;
    try { meta = await getQuestionMeta(slug); } catch (err) {
      if (err.code === 'LEETCODE_NOT_AUTHENTICATED' || err.code === 'LEETCODE_BLOCKED') throw err;
    }
    const subs = await listForSlug(slug, { limit: 20, maxPages: 3 });
    const latestStatus = subs[0] ? subs[0].statusHint : null;

    let candidates = subs.filter((s) => !s.statusHint || s.statusHint === ACCEPTED_STATUS);
    if (preferLangSlug) {
      const same = candidates.filter((s) => LGS.languages.resolveLanguage(s.lang || s.langName).slug === preferLangSlug);
      const other = candidates.filter((s) => !same.includes(s));
      candidates = same.concat(other);
    }

    let checked = 0;
    let lastVerdict = null;
    for (const sub of candidates.slice(0, maxChecks)) {
      checked++;
      const detail = await getDetail(sub.id);
      const verdict = status.verifyAccepted(sub.statusHint, detail);
      lastVerdict = verdict;
      if (verdict.accepted && detail && detail.code) {
        return { accepted: true, slug, meta, submission: sub, detail, verdict, totalSeen: subs.length };
      }
    }
    return {
      accepted: false, slug, meta, checked, totalSeen: subs.length,
      latestStatus: (lastVerdict && lastVerdict.status) || latestStatus
    };
  }

  /* ------------------------------------------------------------------ *
   * Result polling for a just-submitted solution
   * ------------------------------------------------------------------ */
  async function pollSubmissionResult(submissionId, { onUpdate } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const raw = await graphql.restGet(`/submissions/detail/${encodeURIComponent(submissionId)}/check/`);
      const st = status.fromCheckResponse(raw);
      if (typeof onUpdate === 'function') onUpdate(st, raw);
      if (status.isTerminal(st)) return { status: st, raw };
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw E.makeError('LEETCODE_POLL_TIMEOUT', 'Timed out waiting for the judge result.');
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics probe
   * ------------------------------------------------------------------ */
  async function timed(fn) {
    const t0 = Date.now();
    try {
      const value = await fn();
      return { ok: true, ms: Date.now() - t0, value };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: { code: err.code || 'ERROR', message: err.message, status: err.status } };
    }
  }

  function statusCounts(subs) {
    const out = { accepted: 0, notAccepted: 0, unknown: 0 };
    subs.forEach((s) => {
      if (!s.statusHint) out.unknown++;
      else if (s.statusHint === ACCEPTED_STATUS) out.accepted++;
      else out.notAccepted++;
    });
    return out;
  }

  async function probe({ sampleSize = 20 } = {}) {
    const result = {};
    result.auth = await timed(() => getUserStatus());

    for (const src of ['rest', 'graphql']) {
      result[src] = await timed(async () => {
        const page = await listPage({ offset: 0, limit: sampleSize, source: src });
        return {
          count: page.rawCount, hasNext: page.hasNext, hasLastKey: !!page.lastKey,
          fields: page.fields, statusCounts: statusCounts(page.submissions),
          firstId: page.submissions[0] ? page.submissions[0].id : null,
          acceptedId: (page.submissions.find((s) => s.statusHint === ACCEPTED_STATUS) || page.submissions[0] || {}).id || null,
          sample: page.submissions.slice(0, 3).map((s) => ({ slug: s.titleSlug, lang: s.lang, hint: s.statusHint, via: s.statusSource }))
        };
      });
    }

    const detailId = (result.rest.ok && result.rest.value.acceptedId) || (result.graphql.ok && result.graphql.value.acceptedId);
    if (detailId) {
      result.detail = await timed(async () => {
        const d = await getDetail(detailId);
        if (!d) return { empty: true };
        return {
          status: d.status, statusSource: d.statusSource, statusCode: d.statusCode,
          hasCode: !!d.code, codeLength: d.code.length, lang: d.langName,
          hasFrontendId: !!(d.question && d.question.frontendId),
          hasDifficulty: !!(d.question && d.question.difficulty),
          variantUsed: variantMemo.submissionDetails
        };
      });
    } else {
      result.detail = { ok: false, skipped: true, error: { code: 'NO_SAMPLE', message: 'No submission available to test.' } };
    }

    result.stats = await timed(() => getSolvedStats());
    result.solved = await timed(async () => {
      const s = await listSolved({ pageSize: 50, maxPages: 1 });
      return { total: s.total, firstPage: s.items.length, sample: s.items.slice(0, 3).map((i) => i.slug) };
    });
    result.variants = Object.assign({}, variantMemo);
    return result;
  }

  LGS.leetcode = LGS.leetcode || {};
  LGS.leetcode.submissions = {
    listPage, listForSlug, getDetail, getQuestionMeta, completeQuestionMeta,
    getUserStatus, getSolvedStats, listSolved, resolveProblem, pollSubmissionResult, probe, getProblemSolvedState,
    normalizeListItem, normalizeDetail, formatRuntime, formatMemory, toSeconds
  };
})(typeof self !== 'undefined' ? self : window);
