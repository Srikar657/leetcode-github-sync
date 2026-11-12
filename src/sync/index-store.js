/**
 * index-store.js  (src/sync/)
 *
 * The "solution index": one entry per problem folder, listing every
 * language file that has been synced. It is the source of truth for the
 * generated READMEs and the coverage check. (The old design rebuilt READMEs
 * from the activity history, which is capped at 500 entries - so a big
 * account would silently lose rows.) It can be rebuilt from the repository
 * itself at any time (repo-tools.rebuildFromRepo).
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const KEY = () => LGS.CONST.STORAGE_KEYS.SOLUTION_INDEX;
  const lock = LGS.formatter.createMutex();

  async function load() { return LGS.storage.getKey(KEY(), {}); }

  /** Atomic read-modify-write. `fn(index)` mutates and may return a value. */
  function update(fn) {
    return lock(async () => {
      const index = await load();
      const out = await fn(index);
      await LGS.storage.setKey(KEY(), index);
      return out;
    });
  }

  function upsertFromModel(index, model, paths, extra) {
    const entry = index[paths.folder] || { folder: paths.folder, files: {} };
    entry.number = model.problemNumber;
    entry.title = model.title || entry.title || LGS.formatter.titleFromSlug(model.slug);
    entry.slug = model.slug;
    entry.difficulty = model.difficulty;
    entry.url = model.url;
    if (model.topics && model.topics.length) entry.topics = model.topics;
    entry.files[model.extension] = Object.assign({
      language: model.language,
      path: paths.solutionPath,
      submissionId: model.submissionId,
      runtime: model.runtime,
      memory: model.memory,
      syncedAt: LGS.formatter.nowIso()
    }, extra || {});
    index[paths.folder] = entry;
    return entry;
  }

  function toList(index) {
    return Object.values(index).sort((a, b) =>
      (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0) || String(a.folder).localeCompare(String(b.folder)));
  }

  function stats(index) {
    const list = toList(index);
    const byDifficulty = { Easy: 0, Medium: 0, Hard: 0 };
    const byLanguage = {};
    let files = 0;
    list.forEach((e) => {
      if (byDifficulty[e.difficulty] !== undefined) byDifficulty[e.difficulty]++;
      Object.values(e.files || {}).forEach((f) => {
        files++;
        byLanguage[f.language] = (byLanguage[f.language] || 0) + 1;
      });
    });
    return { problems: list.length, files, byDifficulty, byLanguage };
  }

  function has(index, slug, ext) {
    return Object.values(index).some((e) => e.slug === slug && e.files && e.files[ext]);
  }

  function hasProblem(index, slug) {
    return Object.values(index).some((e) => e.slug === slug);
  }

  const PATH_RE = /^(Easy|Medium|Hard|Unknown)\/(\d{4,})-([a-z0-9-]+)\/solution\.([A-Za-z0-9.]+)$/;

  /** Merges what is physically in the repository into the index (keeps richer local metadata). */
  function mergeFromRepoPaths(index, paths) {
    let added = 0;
    for (const p of paths) {
      const m = PATH_RE.exec(p);
      if (!m) continue;
      const [, diff, num, slug, ext] = m;
      const folder = `${diff}/${num}-${slug}`;
      const entry = index[folder] || { folder, files: {} };
      entry.number = entry.number || String(parseInt(num, 10));
      entry.slug = entry.slug || slug;
      entry.title = entry.title || LGS.formatter.titleFromSlug(slug);
      entry.difficulty = entry.difficulty || (diff === 'Unknown' ? null : diff);
      entry.url = entry.url || `https://leetcode.com/problems/${slug}/`;
      if (!entry.files[ext]) {
        entry.files[ext] = { language: LGS.languages.labelForExtension(ext), path: p, submissionId: null, runtime: null, memory: null, syncedAt: null, fromRepo: true };
        added++;
      }
      index[folder] = entry;
    }
    return added;
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.indexStore = { load, update, upsertFromModel, toList, stats, has, hasProblem, mergeFromRepoPaths };
})(typeof self !== 'undefined' ? self : window);
