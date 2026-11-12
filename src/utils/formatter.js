/**
 * formatter.js
 *
 * String/path sanitization and small shared helpers. The path helpers are
 * security-relevant: they stand between "text scraped off a web page" and
 * "a path segment sent to the GitHub API", so they are intentionally strict.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function slugify(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
  }

  function padProblemNumber(num) {
    const n = String(num || '').replace(/\D/g, '');
    if (!n) return '0000';
    return n.length >= 4 ? n : n.padStart(4, '0');
  }

  function sanitizePathSegment(segment) {
    let s = String(segment || '');
    s = s.replace(/\.\./g, '');
    s = s.replace(/[\/\\]/g, '-');
    s = s.replace(/[:?"'<>|*\x00-\x1f]/g, '');
    s = s.trim();
    if (!s) s = 'untitled';
    return s;
  }

  function normalizeDifficulty(d) {
    const s = String(d || '').trim().toLowerCase();
    if (s === 'easy') return 'Easy';
    if (s === 'medium') return 'Medium';
    if (s === 'hard') return 'Hard';
    return null;
  }

  function buildProblemFolder(difficulty, number, slug) {
    const folder = LGS.CONST.DIFFICULTY_FOLDERS[normalizeDifficulty(difficulty)] || 'Unknown';
    const safeSlug = sanitizePathSegment(slugify(slug));
    return `${folder}/${padProblemNumber(number)}-${safeSlug}`;
  }

  function titleFromSlug(slug) {
    return String(slug || '').split('-').filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  function nowIso() { return new Date().toISOString(); }

  function truncate(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** Escape text for use inside a markdown table cell. */
  function escapeMd(text) {
    return String(text == null ? '' : text)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]+/g, ' ');
  }

  /** Source files always end with exactly one trailing newline. */
  function normalizeSource(code) {
    const s = String(code == null ? '' : code);
    return s.endsWith('\n') ? s : s + '\n';
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  }

  /** Promise-chain mutex: serializes async read-modify-write sections. */
  function createMutex() {
    let tail = Promise.resolve();
    return function run(fn) {
      const result = tail.then(fn, fn);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
  }

  function randomId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Git blob SHA-1 of text content (what GitHub's tree API reports). */
  async function gitBlobSha(text) {
    const bytes = new TextEncoder().encode(String(text));
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header, 0);
    all.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  LGS.formatter = {
    slugify, padProblemNumber, sanitizePathSegment, normalizeDifficulty,
    buildProblemFolder, titleFromSlug, nowIso, truncate, escapeMd,
    normalizeSource, sleep, createMutex, randomId, gitBlobSha
  };
})(typeof self !== 'undefined' ? self : window);
