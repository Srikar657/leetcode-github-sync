/**
 * publisher.js  (src/sync/)
 *
 * Writes the GENERATED files (problem READMEs, main README section,
 * TOPICS.md) through a GithubSession. All writes are skipped automatically
 * when the content already matches GitHub, so calling these is cheap.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  async function publishProblemReadme(session, entry) {
    const content = LGS.formatter.normalizeSource(LGS.github.readme.buildProblemReadme(entry));
    return session.put(`${entry.folder}/README.md`, content, `Update README: ${entry.title || entry.slug}`);
  }

  /**
   * The numbers for the README's "Solved on LeetCode" column: LeetCode's verified counts, never lower than
   * what the dashboard's own (live-updated) records show - so the column moves on every solve.
   */
  async function leetcodeCounts() {
    const stored = await LGS.storage.getKey(LGS.CONST.STORAGE_KEYS.LEETCODE_STATS, null);
    let own = null;
    try {
      const snap = await LGS.analytics.store.getSnapshot();
      if (snap.hasData) own = { all: snap.solved, easy: snap.difficulty.Easy, medium: snap.difficulty.Medium, hard: snap.difficulty.Hard };
    } catch (e) { /* analytics are optional here */ }
    if (stored && own) {
      return { all: Math.max(stored.all, own.all), easy: Math.max(stored.easy, own.easy), medium: Math.max(stored.medium, own.medium), hard: Math.max(stored.hard, own.hard), fetchedAt: stored.fetchedAt };
    }
    if (stored) return stored;
    return null; // never invent a LeetCode total we cannot back up
  }

  async function publishMainReadme(session) {
    const settings = await LGS.storage.getSettings();
    const index = await LGS.sync.indexStore.load();
    const entries = LGS.sync.indexStore.toList(index);
    const lcStats = await leetcodeCounts();
    const generated = LGS.github.readme.buildGeneratedSection(entries, lcStats, { topicsFile: settings.generateTopicIndex });
    const existing = await session.getContent('README.md');
    const merged = LGS.formatter.normalizeSource(LGS.github.readme.mergeMainReadme(existing, generated));
    const res = await session.put('README.md', merged, 'Update solutions README');

    if (settings.generateTopicIndex) {
      await session.put('TOPICS.md', LGS.formatter.normalizeSource(LGS.github.readme.buildTopicsDoc(entries)), 'Update topic index');
    }
    return res;
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.publisher = { publishProblemReadme, publishMainReadme };
})(typeof self !== 'undefined' ? self : window);
