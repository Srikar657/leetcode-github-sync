/**
 * status.js  (src/leetcode/)
 *
 * LeetCode reports a judge status in many shapes depending on the
 * endpoint: numeric codes (10 = Accepted), display strings, "status_msg",
 * snake_case or camelCase, and sometimes `null` (the review's Priority 1:
 * `statusDisplay: null`). This module understands ALL of them and is the
 * single place where "is this Accepted?" is decided.
 *
 * Two different notions are kept apart on purpose:
 *   - a HINT  (from a submission *list*): cheap, may be missing -> null
 *   - a VERDICT (verifyAccepted): list hint + the authoritative
 *     submission *detail*; the only thing historical sync trusts.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { LEETCODE_STATUS } = LGS.CONST;

  // Numeric codes (check endpoint + submissionDetails.statusCode)
  const STATUS_CODE_MAP = {
    10: LEETCODE_STATUS.ACCEPTED,
    11: LEETCODE_STATUS.WRONG_ANSWER,
    12: LEETCODE_STATUS.MEMORY_LIMIT_EXCEEDED,
    13: LEETCODE_STATUS.OUTPUT_LIMIT_EXCEEDED,
    14: LEETCODE_STATUS.TIME_LIMIT_EXCEEDED,
    15: LEETCODE_STATUS.RUNTIME_ERROR,
    16: LEETCODE_STATUS.UNKNOWN_ERROR,
    20: LEETCODE_STATUS.COMPILE_ERROR
  };

  const TEXT_MAP = {
    'accepted': LEETCODE_STATUS.ACCEPTED,
    'wrong answer': LEETCODE_STATUS.WRONG_ANSWER,
    'time limit exceeded': LEETCODE_STATUS.TIME_LIMIT_EXCEEDED,
    'memory limit exceeded': LEETCODE_STATUS.MEMORY_LIMIT_EXCEEDED,
    'runtime error': LEETCODE_STATUS.RUNTIME_ERROR,
    'compile error': LEETCODE_STATUS.COMPILE_ERROR,
    'output limit exceeded': LEETCODE_STATUS.OUTPUT_LIMIT_EXCEEDED,
    'internal error': LEETCODE_STATUS.UNKNOWN_ERROR,
    'unknown error': LEETCODE_STATUS.UNKNOWN_ERROR,
    'pending': LEETCODE_STATUS.PENDING,
    'judging': LEETCODE_STATUS.JUDGING,
    'running': LEETCODE_STATUS.JUDGING,
    'compiling': LEETCODE_STATUS.JUDGING
  };

  // Short codes that appear in *list* payloads. Hints only.
  const LIST_SHORT_CODES = {
    ac: LEETCODE_STATUS.ACCEPTED,
    wa: LEETCODE_STATUS.WRONG_ANSWER,
    tle: LEETCODE_STATUS.TIME_LIMIT_EXCEEDED,
    mle: LEETCODE_STATUS.MEMORY_LIMIT_EXCEEDED,
    re: LEETCODE_STATUS.RUNTIME_ERROR,
    ce: LEETCODE_STATUS.COMPILE_ERROR,
    ole: LEETCODE_STATUS.OUTPUT_LIMIT_EXCEEDED
  };

  function cleanText(text) {
    return String(text).trim().toLowerCase().replace(/[\s_]+/g, ' ').replace(/[.!:]+$/, '');
  }

  /** Text -> normalized status, or null when not recognized / empty. */
  function parseText(text) {
    if (text == null) return null;
    const key = cleanText(text);
    if (!key) return null;
    return TEXT_MAP[key] || null;
  }

  /** Numeric code (number or numeric string) -> normalized status, or null. */
  function fromStatusCode(code) {
    if (code == null || code === '') return null;
    const n = typeof code === 'number' ? code : (/^\d+$/.test(String(code).trim()) ? Number(String(code).trim()) : NaN);
    if (!Number.isFinite(n)) return null;
    return STATUS_CODE_MAP[n] || null;
  }

  /** Any scalar (string or number) -> normalized status, or null. */
  function fromAny(value) {
    if (value == null) return null;
    if (typeof value === 'number') return fromStatusCode(value);
    const asCode = fromStatusCode(value);
    if (asCode) return asCode;
    const asText = parseText(value);
    if (asText) return asText;
    const short = LIST_SHORT_CODES[cleanText(value)];
    return short || null;
  }

  /**
   * Examines every field LeetCode is known to use for a submission's
   * status and returns { status, source } or { status: null, source: null }.
   * Display-string fields win over numeric ones because they are the least
   * ambiguous; a recognized value in ANY field is enough.
   */
  function fromSubmissionRecord(rec) {
    if (!rec || typeof rec !== 'object') return { status: null, source: null };

    const textFields = ['statusDisplay', 'status_display', 'statusMsg', 'status_msg', 'statusText', 'status_text'];
    for (const f of textFields) {
      const s = parseText(rec[f]);
      if (s) return { status: s, source: f };
    }
    const codeFields = ['statusCode', 'status_code'];
    for (const f of codeFields) {
      const s = fromStatusCode(rec[f]);
      if (s) return { status: s, source: f };
    }
    if (rec.status != null) {
      const s = fromAny(rec.status);
      if (s) return { status: s, source: 'status' };
    }
    if (rec.isPending === true || rec.is_pending === true || rec.is_pending === 'Pending') {
      return { status: LEETCODE_STATUS.PENDING, source: 'isPending' };
    }
    return { status: null, source: null };
  }

  /** The review's `getSubmissionStatus(sub)` - null means "unknown", never "Unknown Error". */
  function getSubmissionStatus(sub) {
    return fromSubmissionRecord(sub).status;
  }

  /**
   * Response of .../submissions/detail/<id>/check/
   * { state: 'STARTED'|'PENDING'|'SUCCESS', status_code, status_msg, ... }
   */
  function fromCheckResponse(raw) {
    if (!raw) return LEETCODE_STATUS.UNKNOWN_ERROR;
    if (raw.state === 'PENDING') return LEETCODE_STATUS.PENDING;
    if (raw.state === 'STARTED') return LEETCODE_STATUS.JUDGING;
    const rec = fromSubmissionRecord(raw);
    return rec.status || LEETCODE_STATUS.UNKNOWN_ERROR;
  }

  /** Legacy helper: unknown text maps to "Unknown Error" (never to Accepted). */
  function fromText(text) {
    return parseText(text) || LEETCODE_STATUS.UNKNOWN_ERROR;
  }

  function isAccepted(status) { return status === LEETCODE_STATUS.ACCEPTED; }
  function isInProgress(status) { return LGS.CONST.IN_PROGRESS_STATUSES.has(status); }
  function isTerminal(status) { return !!status && !isInProgress(status); }

  /**
   * THE verdict used by historical + current sync (review item 4).
   *
   *   detail status known  -> it decides (the list hint can never override it)
   *   else list hint known -> it decides
   *   else                 -> NOT accepted ("unverifiable")
   *
   * `detail` may be a raw submissionDetails object or a normalized one.
   */
  function verifyAccepted(listHint, detail) {
    const fromDetail = detail ? fromSubmissionRecord(detail).status : null;
    if (fromDetail) {
      return { accepted: fromDetail === LEETCODE_STATUS.ACCEPTED, status: fromDetail, source: 'detail' };
    }
    if (listHint) {
      return { accepted: listHint === LEETCODE_STATUS.ACCEPTED, status: listHint, source: 'list' };
    }
    return { accepted: false, status: null, source: 'none' };
  }

  LGS.leetcode = LGS.leetcode || {};
  LGS.leetcode.status = {
    fromCheckResponse, fromText, parseText, fromStatusCode, fromAny,
    fromSubmissionRecord, getSubmissionStatus, verifyAccepted,
    isAccepted, isInProgress, isTerminal, STATUS_CODE_MAP, TEXT_MAP
  };
})(typeof self !== 'undefined' ? self : window);
