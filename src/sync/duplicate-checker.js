/**
 * duplicate-checker.js  (src/sync/)
 *
 * Computes the target GitHub paths for a model. Layout:
 *
 *   <Difficulty>/<0001>-<slug>/solution.<ext>     one file PER LANGUAGE
 *   <Difficulty>/<0001>-<slug>/README.md
 *
 * Several languages for the same problem coexist. "Python" and "Python3"
 * share solution.py (same file, same slot). A "duplicate" therefore means:
 * a file for this problem+extension already exists in the repository.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  function computeTargetPaths(model) {
    const folder = LGS.formatter.buildProblemFolder(model.difficulty, model.problemNumber, model.slug);
    const ext = LGS.formatter.sanitizePathSegment(model.extension);
    return {
      folder,
      solutionPath: `${folder}/solution.${ext}`,
      readmePath: `${folder}/README.md`
    };
  }

  LGS.sync = LGS.sync || {};
  LGS.sync.duplicateChecker = { computeTargetPaths };
})(typeof self !== 'undefined' ? self : window);
