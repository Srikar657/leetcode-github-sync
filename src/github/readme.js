/**
 * readme.js  (src/github/)
 *
 * Pure markdown generators (no I/O):
 *  - per-problem README (lists every language synced for that problem)
 *  - the generated section of the repository README.md, between markers
 *    so anything you write by hand outside the markers is never touched
 *  - TOPICS.md, an index of problems by topic
 *
 * The generated output deliberately contains NO timestamps (except the
 * LeetCode verification date), so an unchanged repo produces byte-identical
 * files and therefore zero commits.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { README_MARKERS } = LGS.CONST;
  const { escapeMd } = LGS.formatter;

  function buildProblemReadme(entry) {
    const lines = [];
    lines.push(`# ${entry.title || entry.slug}`, '');
    if (entry.number) lines.push(`- Problem: #${entry.number}`);
    if (entry.difficulty) lines.push(`- Difficulty: ${entry.difficulty}`);
    if (entry.url) lines.push(`- LeetCode: ${entry.url}`);
    lines.push('', '## Solutions', '');
    const files = Object.entries(entry.files || {}).sort((a, b) => a[1].language.localeCompare(b[1].language));
    lines.push('| Language | File | Runtime | Memory |', '|----------|------|---------|--------|');
    files.forEach(([ext, f]) => {
      const note = /\.txt$/.test(ext) ? ' (unrecognized language)' : '';
      lines.push(`| ${escapeMd(f.language)}${note} | [solution.${ext}](solution.${ext}) | ${escapeMd(f.runtime || '-')} | ${escapeMd(f.memory || '-')} |`);
    });
    if (entry.topics && entry.topics.length) {
      lines.push('', '## Topics', '');
      entry.topics.forEach((t) => lines.push(`- ${t}`));
    }
    lines.push('');
    return lines.join('\n');
  }

  function link(folder) { return encodeURI(folder) + '/'; }

  function solutionTable(entries) {
    const lines = ['| # | Problem | Language(s) | Link |', '|---|---------|-------------|------|'];
    entries.forEach((e) => {
      const langs = Object.values(e.files || {}).map((f) => f.language).join(', ');
      const title = e.url ? `[${escapeMd(e.title)}](${e.url})` : escapeMd(e.title);
      lines.push(`| ${e.number || ''} | ${title} | ${escapeMd(langs)} | [folder](${link(e.folder)}) |`);
    });
    return lines;
  }

  /**
   * @param {object[]} entries index entries (sorted)
   * @param {object|null} lcStats {all, easy, medium, hard, fetchedAt} verified from LeetCode, or null
   * @param {object} opts {topicsFile: boolean}
   */
  function buildGeneratedSection(entries, lcStats, opts = {}) {
    const byDiff = { Easy: [], Medium: [], Hard: [], Other: [] };
    const byLang = {};
    let fileCount = 0;
    entries.forEach((e) => {
      (byDiff[e.difficulty] || byDiff.Other).push(e);
      Object.values(e.files || {}).forEach((f) => { fileCount++; byLang[f.language] = (byLang[f.language] || 0) + 1; });
    });

    const L = [README_MARKERS.START, '', '## Progress', ''];
    L.push('| Difficulty | Synced to GitHub |' + (lcStats ? ' Solved on LeetCode |' : ''));
    L.push('|------------|-----------------:|' + (lcStats ? '--------------------:|' : ''));
    [['Easy', 'easy'], ['Medium', 'medium'], ['Hard', 'hard']].forEach(([d, k]) => {
      L.push(`| ${d} | ${byDiff[d].length} |` + (lcStats ? ` ${lcStats[k]} |` : ''));
    });
    L.push(`| **Total** | **${entries.length}** |` + (lcStats ? ` **${lcStats.all}** |` : ''));
    L.push('', `${entries.length} problem(s), ${fileCount} solution file(s) in this repository.`);
    if (lcStats) {
      const date = lcStats.fetchedAt ? String(lcStats.fetchedAt).slice(0, 10) : '';
      L.push(`Solved-on-LeetCode counts are kept in sync with LeetCode${date ? ` (last checked ${date})` : ''}.`);
      if (lcStats.all > entries.length) L.push(`> ${lcStats.all - entries.length} solved problem(s) are not in this repository yet.`);
    }
    L.push('', '## Languages', '', '| Language | Files |', '|----------|------:|');
    Object.entries(byLang).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([l, c]) => L.push(`| ${escapeMd(l)} | ${c} |`));
    if (opts.topicsFile) L.push('', 'Browse by topic: [TOPICS.md](TOPICS.md)');
    L.push('', '## Solutions', '');

    ['Easy', 'Medium', 'Hard', 'Other'].forEach((d) => {
      const list = byDiff[d];
      if (!list.length) return;
      const title = d === 'Other' ? 'Unclassified' : d;
      if (list.length > 40) {
        L.push(`<details><summary><b>${title}</b> (${list.length})</summary>`, '', ...solutionTable(list), '', '</details>', '');
      } else {
        L.push(`### ${title} (${list.length})`, '', ...solutionTable(list), '');
      }
    });
    L.push(README_MARKERS.END);
    return L.join('\n');
  }

  function buildTopicsDoc(entries) {
    const byTopic = {};
    entries.forEach((e) => (e.topics || []).forEach((t) => { (byTopic[t] = byTopic[t] || []).push(e); }));
    const topics = Object.keys(byTopic).sort((a, b) => byTopic[b].length - byTopic[a].length || a.localeCompare(b));
    const L = ['# Solutions by Topic', '', 'Generated automatically by LeetCode GitHub Sync. Do not edit by hand.', ''];
    if (!topics.length) L.push('No topic information is available yet.');
    topics.forEach((t) => {
      L.push(`## ${t} (${byTopic[t].length})`, '');
      byTopic[t].forEach((e) => L.push(`- ${e.number ? '#' + e.number + ' ' : ''}[${escapeMd(e.title)}](${link(e.folder)}) - ${e.difficulty || ''}`));
      L.push('');
    });
    return L.join('\n');
  }

  function mergeMainReadme(existing, generated) {
    const header = '# LeetCode Solutions\n\nSolutions automatically synchronized from LeetCode.\n\n';
    if (!existing) return header + generated + '\n';
    const s = existing.indexOf(README_MARKERS.START);
    const e = existing.indexOf(README_MARKERS.END);
    if (s !== -1 && e !== -1 && e > s) {
      return existing.slice(0, s) + generated + existing.slice(e + README_MARKERS.END.length);
    }
    const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
    return existing + sep + generated + '\n';
  }

  LGS.github = LGS.github || {};
  LGS.github.readme = { buildProblemReadme, buildGeneratedSection, buildTopicsDoc, mergeMainReadme };
})(typeof self !== 'undefined' ? self : window);
