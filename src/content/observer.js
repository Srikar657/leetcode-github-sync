/**
 * observer.js  (src/content/)
 *
 * A PASSIVE observer. This file contains no code that presses, clicks,
 * dispatches events to, or otherwise operates LeetCode's Submit (or Run)
 * button, and nothing here ever submits code anywhere. The user submits;
 * LeetCode judges; this watcher only READS what LeetCode reports.
 *
 * How it notices a solve (it does NOT depend on a button being clicked):
 *   1. When a problem page opens (or you navigate to another problem) it
 *      records the problem's EXISTING submissions as a baseline - so opening
 *      or refreshing a page can never trigger anything.
 *   2. Every few seconds it asks LeetCode for that problem's latest
 *      submissions. A submission that is not in the baseline was made by YOU
 *      just now (however you submitted: button, keyboard shortcut, …).
 *   3. It follows that submission to LeetCode's FINAL verdict.
 *   4. Only if the verdict is Accepted does it continue:
 *        a. fetch the submission's detail (status code + the EXACT code that
 *           was judged - never the editor's current text),
 *        b. confirm LeetCode now marks the problem itself as SOLVED,
 *        c. report to the background worker, which saves to GitHub.
 *   Run / "all test cases passed" results are never looked at.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});
  const { parser } = LGS.leetcode;
  const subs = () => LGS.leetcode.submissions;
  const { MSG, LEETCODE_STATUS } = LGS.CONST;

  const state = {
    slug: null, baselineReady: false, seen: new Set(), baselineTs: 0,
    tracking: false, retryAfter: {}, ticking: false
  };

  /* ---- live view model (consumed by the floating panel) ---- */
  const view = { phase: 'idle', slug: null, title: null, status: null, submissionId: null, error: null, updatedAt: 0, runtime: null, memory: null, language: null, difficulty: null, topics: [] };
  const listeners = new Set();
  function emit(patch) {
    Object.assign(view, patch, { updatedAt: Date.now() });
    listeners.forEach((fn) => { try { fn(view); } catch (e) { /* UI errors must never break tracking */ } });
  }
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function send(message) {
    if (!extensionAlive()) return;
    try { chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }); } catch (e) { /* worker asleep / reloaded */ }
  }

  /** Reads the problem's existing submissions once; nothing in it is ever acted on. */
  async function captureBaseline(slug) {
    const list = await subs().listForSlug(slug, { limit: 20, maxPages: 1 });
    state.seen = new Set(list.map((s) => String(s.id)));
    state.baselineTs = list.reduce((m, s) => Math.max(m, s.timestamp), 0);
    state.baselineReady = true;
  }

  async function onSlugChange(slug) {
    state.slug = slug;
    state.baselineReady = false;
    state.seen = new Set();
    emit({ phase: 'idle', slug, title: null, status: null, submissionId: null, error: null });
    if (slug) await captureBaseline(slug);
  }

  /** LeetCode's solved state can lag a moment behind the verdict: wait (bounded) for it. */
  async function confirmSolved(slug) {
    let last = 'unknown';
    const { SOLVED_CONFIRM_TRIES, SOLVED_CONFIRM_DELAY_MS } = LGS.CONST;
    for (let i = 0; i < SOLVED_CONFIRM_TRIES; i++) {
      last = await subs().getProblemSolvedState(slug);
      if (last !== 'not-solved') return last; // 'solved' or 'unknown' (field unreadable)
      await new Promise((r) => setTimeout(r, SOLVED_CONFIRM_DELAY_MS));
    }
    return last;
  }

  async function track(sub, slug) {
    state.tracking = true;
    let lastSent = null;
    try {
      const metaPromise = subs().completeQuestionMeta(null, slug).catch(() => null);
      emit({ phase: 'checking', slug, title: null, status: 'Judging', error: null, submissionId: String(sub.id) });
      send({ type: MSG.SUBMISSION_STATUS, payload: { slug, submissionId: String(sub.id), status: 'Judging' } });

      const result = await subs().pollSubmissionResult(sub.id, {
        onUpdate: (st) => {
          if (st === lastSent) return;
          lastSent = st; emit({ status: st });
        }
      });

      let finalStatus = result.status;
      let code = null; let solvedState = null; let leetcodeStats = null;
      let runtime = sub.runtime; let memory = sub.memory;
      let language = sub.langName || sub.lang || null;
      const apiMeta = await metaPromise;
      let problem = { slug, number: apiMeta && apiMeta.number, title: apiMeta && apiMeta.title, difficulty: apiMeta && apiMeta.difficulty, tags: (apiMeta && apiMeta.tags) || [] };

      if (finalStatus === LEETCODE_STATUS.ACCEPTED) {
        // (a) the exact judged code + LeetCode's own status code for THIS submission
        const detail = await subs().getDetail(sub.id);
        const verdict = LGS.leetcode.status.verifyAccepted(finalStatus, detail);
        if (!verdict.accepted) {
          finalStatus = verdict.status || LEETCODE_STATUS.UNKNOWN_ERROR;
        } else {
          code = detail.code || null;
          runtime = detail.runtime || runtime; memory = detail.memory || memory;
          language = detail.langName || detail.langSlug || language;
          const meta = await subs().completeQuestionMeta(detail.question, slug);
          problem = { slug, number: meta.number || problem.number, title: meta.title || problem.title, difficulty: meta.difficulty || problem.difficulty, tags: meta.tags && meta.tags.length ? meta.tags : problem.tags };
          // (b) LeetCode itself must now say the problem is solved
          solvedState = await confirmSolved(slug);
          // LeetCode's own solved counts, right now, so the README's "Solved on LeetCode" is current.
          if (solvedState !== 'not-solved') { try { leetcodeStats = await subs().getSolvedStats(); } catch (e) { /* optional: the background falls back */ } }
          if (solvedState === 'not-solved') {
            state.retryAfter[String(sub.id)] = Date.now() + 30000;
            state.seen.delete(String(sub.id)); // look again shortly; nothing is saved meanwhile
            emit({ phase: 'error', error: "LeetCode hasn't marked this problem as solved yet - waiting. Nothing was saved." });
            return;
          }
        }
      }

      emit({ phase: 'done', status: finalStatus, submissionId: String(sub.id), title: problem.title || slug, runtime, memory, language, difficulty: problem.difficulty || null, topics: problem.tags || [], error: null });
      LGS.content.lastResult = { at: Date.now(), slug, status: finalStatus, submissionId: String(sub.id) };
      send({ type: MSG.SUBMISSION_RESULT, payload: { submissionId: String(sub.id), status: finalStatus, runtime, memory, language, problem, code, solvedState, leetcodeStats } });
    } catch (err) {
      LGS.logger.warn('Could not follow submission', sub.id, err.message);
      if (['LEETCODE_NOT_AUTHENTICATED', 'LEETCODE_BLOCKED', 'LEETCODE_RATE_LIMITED', 'LEETCODE_NETWORK_ERROR', 'LEETCODE_TIMEOUT', 'LEETCODE_POLL_TIMEOUT'].includes(err.code)) {
        state.seen.delete(String(sub.id)); // transient: look at it again on a later tick
        state.retryAfter[String(sub.id)] = Date.now() + 15000;
      }
      emit({ phase: 'error', error: err.message });
    } finally {
      state.tracking = false;
    }
  }

  /** One passive look at LeetCode. Called every few seconds while a problem tab is visible. */
  async function tick() {
    if (state.ticking || state.tracking || !extensionAlive() || document.visibilityState === 'hidden') return;
    state.ticking = true;
    try {
      const slug = parser.getSlugFromUrl();
      if (slug !== state.slug) { await onSlugChange(slug); return; }
      if (!slug) return;
      if (!state.baselineReady) { await captureBaseline(slug); return; }

      const page = await subs().listPage({ offset: 0, limit: 5, slug });
      const now = Date.now();
      const fresh = page.submissions
        .filter((s) => s.id && !state.seen.has(String(s.id)) && !(state.retryAfter[String(s.id)] > now))
        .sort((a, b) => a.timestamp - b.timestamp);
      if (!fresh.length) return;
      const next = fresh[0];
      state.seen.add(String(next.id));
      await track(next, slug);
    } catch (err) {
      LGS.logger.debug('watch tick failed:', err.message);
    } finally {
      state.ticking = false;
    }
  }

  LGS.content = LGS.content || {};
  LGS.content.observer = { tick, onChange, view, isBusy: () => state.tracking, _state: state };
})(typeof self !== 'undefined' ? self : window);
