/**
 * metadata.js  (src/leetcode/)
 *
 * Builds the single normalized "submission model" that every sync path
 * (live, manual, historical) works with, and validates it.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  /**
   * @param {object} p
   * @param {string} p.submissionId
   * @param {object} p.problem   { number, title, slug, difficulty, url, tags }
   * @param {string} p.rawLanguage  slug or display name
   * @param {string} p.code
   * @param {string} p.status    normalized LEETCODE_STATUS value
   */
  function buildSubmissionModel(p) {
    const lang = LGS.languages.resolveLanguage(p.rawLanguage);
    const problem = p.problem || {};
    const slug = problem.slug || null;

    return {
      submissionId: p.submissionId ? String(p.submissionId) : null,
      problemId: problem.problemId || null,
      problemNumber: problem.number ? String(problem.number) : null,
      title: problem.title || null,
      slug,
      difficulty: LGS.formatter.normalizeDifficulty(problem.difficulty),
      language: lang.label,
      languageSlug: lang.slug,
      languageUnknown: lang.unknown,
      extension: lang.extension,
      code: p.code || '',
      status: p.status,
      runtime: p.runtime || null,
      memory: p.memory || null,
      timestamp: p.timestamp || Date.now(),
      url: problem.url || (slug ? `https://leetcode.com/problems/${slug}/` : null),
      topics: Array.isArray(problem.tags) ? problem.tags : []
    };
  }

  /** Returns a list of human-readable problems; empty list = syncable. */
  function problemsWith(model) {
    const issues = [];
    if (!model) return ['no submission'];
    if (model.status !== LGS.CONST.ACCEPTED_STATUS) issues.push(`status is ${model.status || 'unknown'}, not Accepted`);
    if (!model.problemNumber) issues.push('problem number is missing');
    if (!model.slug) issues.push('problem slug is missing');
    if (!model.difficulty) issues.push('difficulty is missing');
    if (!model.code || !model.code.trim()) issues.push('code is empty');
    return issues;
  }

  function isSyncable(model) {
    return problemsWith(model).length === 0;
  }

  LGS.leetcode = LGS.leetcode || {};
  LGS.leetcode.metadata = { buildSubmissionModel, isSyncable, problemsWith };
})(typeof self !== 'undefined' ? self : window);
