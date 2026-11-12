/**
 * logger.js
 *
 * Tiny logging wrapper. Debug output only prints when "Debug logging" is
 * enabled; warnings/errors always print. Secrets are redacted both by
 * key name (token, cookie, ...) and by pattern (GitHub token formats),
 * so a token can never end up in a log line even by accident.
 *
 * A ring buffer is mirrored (debounced) into chrome.storage.local so the
 * Control Center can show the log without devtools. Each context (background
 * vs. content/pages) writes its own key so they never overwrite each other.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  const MAX_BUFFER = 300;
  const CONTEXT = (typeof window === 'undefined' || typeof document === 'undefined') ? 'bg' : 'page';
  const SECRET_KEYS = ['token', 'password', 'cookie', 'csrf', 'secret', 'authorization', 'code'];
  const TOKEN_PATTERN = /(github_pat_|gh[pousr]_)[A-Za-z0-9_]{10,}/g;

  let buffer = [];
  let debugEnabled = false;
  let flushTimer = null;

  function scrubString(s) {
    return String(s).replace(TOKEN_PATTERN, '[redacted-token]');
  }

  function redact(value, depth) {
    if (value == null) return value;
    if (typeof value === 'string') return scrubString(value);
    if (value instanceof Error) return scrubString(value.message);
    if (typeof value !== 'object') return value;
    if ((depth || 0) > 4) return '[deep]';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, (depth || 0) + 1));
    const out = {};
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      // "code" is source code - never write it to logs
      if (SECRET_KEYS.some((s) => lower === s || (s !== 'code' && lower.includes(s)))) out[key] = '[redacted]';
      else out[key] = redact(value[key], (depth || 0) + 1);
    }
    return out;
  }

  function format(args) {
    return args.map((a) => {
      const safe = redact(a);
      if (typeof safe === 'string') return safe;
      try { return JSON.stringify(safe); } catch (e) { return '[unserializable]'; }
    }).join(' ');
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        if (global.chrome && chrome.storage && chrome.storage.local && LGS.CONST) {
          chrome.storage.local.set({ [LGS.CONST.STORAGE_KEYS.DEBUG_LOG_PREFIX + CONTEXT]: buffer }, () => {
            void (global.chrome.runtime && chrome.runtime.lastError);
          });
        }
      } catch (e) { /* context may be invalidated - ignore */ }
    }, 800);
  }

  function push(level, args) {
    buffer.push({ level, ctx: CONTEXT, time: new Date().toISOString(), message: format(args) });
    if (buffer.length > MAX_BUFFER) buffer.shift();
    scheduleFlush();
  }

  const logger = {
    setDebugEnabled(value) { debugEnabled = !!value; },
    getBuffer: () => buffer.slice(),
    info(...args) { if (debugEnabled) console.info('[LGS]', ...args.map((a) => redact(a))); push('info', args); },
    warn(...args) { console.warn('[LGS]', ...args.map((a) => redact(a))); push('warn', args); },
    error(...args) { console.error('[LGS]', ...args.map((a) => redact(a))); push('error', args); },
    debug(...args) { if (!debugEnabled) return; console.debug('[LGS]', ...args.map((a) => redact(a))); push('debug', args); },
    redact,
    scrubString
  };

  LGS.logger = logger;
})(typeof self !== 'undefined' ? self : window);
