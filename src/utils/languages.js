/**
 * languages.js
 *
 * Maps LeetCode's reported language (slug like "python3"/"cpp", or a
 * display label like "C++") to a label and a file extension.
 *
 * Unknown languages are never guessed: they are saved as
 * solution.<name>.txt and flagged so the README can say so.
 * Dialects that share a generic extension (the SQL flavours) get a
 * distinguishing infix so they never overwrite each other.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  const LANGUAGE_TABLE = {
    python: { label: 'Python', extension: 'py' },
    python3: { label: 'Python3', extension: 'py' },
    pythondata: { label: 'Pandas', extension: 'py' },
    c: { label: 'C', extension: 'c' },
    cpp: { label: 'C++', extension: 'cpp' },
    java: { label: 'Java', extension: 'java' },
    javascript: { label: 'JavaScript', extension: 'js' },
    typescript: { label: 'TypeScript', extension: 'ts' },
    csharp: { label: 'C#', extension: 'cs' },
    golang: { label: 'Go', extension: 'go' },
    rust: { label: 'Rust', extension: 'rs' },
    kotlin: { label: 'Kotlin', extension: 'kt' },
    swift: { label: 'Swift', extension: 'swift' },
    ruby: { label: 'Ruby', extension: 'rb' },
    php: { label: 'PHP', extension: 'php' },
    scala: { label: 'Scala', extension: 'scala' },
    dart: { label: 'Dart', extension: 'dart' },
    racket: { label: 'Racket', extension: 'rkt' },
    erlang: { label: 'Erlang', extension: 'erl' },
    elixir: { label: 'Elixir', extension: 'ex' },
    bash: { label: 'Bash', extension: 'sh' },
    mysql: { label: 'MySQL', extension: 'mysql.sql' },
    mssql: { label: 'MS SQL Server', extension: 'mssql.sql' },
    oraclesql: { label: 'Oracle', extension: 'oracle.sql' },
    postgresql: { label: 'PostgreSQL', extension: 'postgresql.sql' }
  };

  // normalized (lower-case, [a-z0-9+#] only) alias -> canonical slug
  const ALIAS_TO_SLUG = {
    python: 'python', python3: 'python3', pythondata: 'pythondata', pandas: 'pythondata',
    c: 'c', 'c++': 'cpp', cpp: 'cpp',
    java: 'java', javascript: 'javascript', js: 'javascript',
    typescript: 'typescript', ts: 'typescript',
    'c#': 'csharp', csharp: 'csharp',
    go: 'golang', golang: 'golang',
    rust: 'rust', kotlin: 'kotlin', swift: 'swift', ruby: 'ruby', php: 'php',
    scala: 'scala', dart: 'dart', racket: 'racket', erlang: 'erlang', elixir: 'elixir',
    bash: 'bash', shell: 'bash',
    mysql: 'mysql', mssql: 'mssql', mssqlserver: 'mssql', sqlserver: 'mssql',
    oraclesql: 'oraclesql', oracle: 'oraclesql', postgresql: 'postgresql', postgres: 'postgresql'
  };

  function normalize(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9+#]/g, '');
  }

  function resolveLanguage(rawName) {
    const key = normalize(rawName);
    const slug = ALIAS_TO_SLUG[key];
    if (slug && LANGUAGE_TABLE[slug]) {
      const row = LANGUAGE_TABLE[slug];
      return { slug, label: row.label, extension: row.extension, unknown: false };
    }
    const safe = key.replace(/[^a-z0-9]/g, '') || 'unknown';
    return { slug: null, label: rawName || 'Unknown', extension: `${safe}.txt`, unknown: true };
  }

  /** Reverse lookup used when rebuilding the index from repo file names. */
  function labelForExtension(ext) {
    for (const slug of Object.keys(LANGUAGE_TABLE)) {
      // prefer the canonical python3 label over the legacy "python"
      if (LANGUAGE_TABLE[slug].extension === ext && slug !== 'python' && slug !== 'pythondata') return LANGUAGE_TABLE[slug].label;
    }
    if (/\.txt$/.test(ext)) return ext.replace(/\.txt$/, '');
    return ext;
  }

  LGS.languages = { LANGUAGE_TABLE, resolveLanguage, normalize, labelForExtension };
})(typeof self !== 'undefined' ? self : window);
