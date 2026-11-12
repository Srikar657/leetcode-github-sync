/**
 * parser.js  (src/leetcode/)
 *
 * DOM-based page parsing. This is the LEAST reliable data source
 * (LeetCode's CSS class names change often), so it is only a FALLBACK:
 * problem metadata comes from the GraphQL API first (submissions.js),
 * then the page, then the URL (review item 17).
 *
 * What it is still used for: the slug (URL, very stable) and the editor's
 * selected language label. It only READS the page.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function text(el) { return el ? (el.textContent || '').trim() : ''; }

  function getSlugFromUrl(pathname) {
    const match = (pathname || location.pathname).match(/\/problems\/([a-z0-9-]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  function getTitleAndNumber() {
    const selectors = [
      '[data-cy="question-title"]',
      'div[class*="question-title"]',
      'a[href^="/problems/"] + div',
      'h1'
    ];
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { /* bad selector */ }
      const t = text(el);
      const match = t.match(/^(\d+)\.\s*(.+)$/);
      if (match) return { number: match[1], title: match[2].trim() };
    }
    const slug = getSlugFromUrl();
    if (slug) return { number: null, title: LGS.formatter.titleFromSlug(slug) };
    return { number: null, title: null };
  }

  function getDifficulty() {
    const selectors = ['[diff]', 'div[class*="difficulty"]', 'span[class*="difficulty"]'];
    for (const sel of selectors) {
      let els = [];
      try { els = document.querySelectorAll(sel); } catch (e) { /* ignore */ }
      for (const el of els) {
        const d = LGS.formatter.normalizeDifficulty(text(el));
        if (d) return d;
      }
    }
    return null;
  }

  function getTags() {
    const tags = new Set();
    for (const sel of ['a[href^="/tag/"]', 'a[class*="topic-tag"]']) {
      try { document.querySelectorAll(sel).forEach((el) => { const t = text(el); if (t) tags.add(t); }); } catch (e) { /* ignore */ }
    }
    return Array.from(tags);
  }

  function getSelectedLanguageLabel() {
    const selectors = [
      'button[id^="headlessui-listbox-button"]',
      '[data-e2e-locator="lang-select"]',
      'button[class*="lang-select"]',
      '#lang-select'
    ];
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { /* ignore */ }
      const t = text(el);
      if (t) return t;
    }
    return null;
  }

  function getCurrentProblemMeta() {
    const { number, title } = getTitleAndNumber();
    return {
      number, title,
      slug: getSlugFromUrl(),
      difficulty: getDifficulty(),
      tags: getTags(),
      url: location.origin + location.pathname.replace(/\/(description|solutions|submissions).*$/, '').replace(/\/$/, '') + '/',
      language: getSelectedLanguageLabel()
    };
  }

  LGS.leetcode = LGS.leetcode || {};
  LGS.leetcode.parser = {
    getSlugFromUrl, getTitleAndNumber, getDifficulty, getTags,
    getSelectedLanguageLabel, getCurrentProblemMeta
  };
})(typeof self !== 'undefined' ? self : window);
