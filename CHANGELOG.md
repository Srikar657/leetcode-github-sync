# Changelog

## 3.0.1

- **Compact popup.** The toolbar popup now shows only the essentials: problems solved, +today, Easy/Medium/Hard, today's progress, your last three solves and a GitHub status dot. Everything else (topics, languages, heatmap, week/month, acceptance, full history, search) stays one click away in the Dashboard.
- **README fix:** the "Solved on LeetCode" column now updates on every solve, together with "Synced to GitHub". It used to refresh only during bulk operations. After a confirmed solve the watcher reads LeetCode's real solved counts; if that call fails, or LeetCode lags behind, the stored count is bumped for the new solve; re-solving an old problem never inflates it; the README never shows a LeetCode number lower than the dashboard's own records.
- Tests: 65.

## 3.0.0 — LeetHub: progress dashboard + passive observer

**Behaviour change (important):** the extension **never** presses, clicks or simulates LeetCode's Submit/Run button and never submits code. *Auto Submit was removed completely*, together with the editor reader and main-world script that only existed to support it. Detection is now passive: baseline of existing submissions → watch for a new one → follow it to LeetCode's final verdict → verify the exact submission and that LeetCode marks the problem solved → only then save to GitHub.

**New**
- Premium dark popup + full Progress dashboard: solved count, +today, today's progress (optional daily goal), current/longest streak, difficulty, topics (click to drill down), languages, acceptance rate, week/month summaries, 16-week heatmap, recent activity, live submission status, searchable/filterable solved list.
- LeetCode state and GitHub state are separate. GitHub saving is a persisted queue with automatic retry/backoff (alarm-driven, survives service-worker restarts) and a Retry fallback; a GitHub failure never un-solves a problem.
- Failed submissions are recorded as attempts (acceptance rate) but never count as solved or saved.
- Quiet incremental stats refresh (never opens a tab by itself) and one-click full history import.
- Read-only status panel on LeetCode problem pages (can be turned off).
- New logo everywhere.

**Fixed**
- The save queue could miss a job enqueued while another pass was finishing; passes now coalesce.

**Tests:** 61 (was 35), including a source scan that fails if any code able to submit or click ever appears.

## 2.0.0 — production hardening

Complete response to the 25-point review. Highlights:

**Correctness (the blockers)**
- Accepted detection no longer depends on one field. `statusDisplay`, `status_display`, `status_msg`, numeric/string `status`, `statusCode` are all understood; a missing value means *unknown*, never "Unknown Error".
- Every historical candidate is **verified through its submission detail** (numeric `statusCode`) before upload. The list can never override the detail.
- Two independent submission-list sources (REST `/api/submissions/` + GraphQL `submissionList`) with automatic fallback, GraphQL query variants for schema drift, and a per-problem fallback driven by your solved-problem list.
- "Sync Current" now asks LeetCode for the newest verified Accepted submission of the problem instead of trusting `lastKnownStatus`, and works even when you click it from the dashboard tab.
- Pagination guards: offset advances by what the server actually returned, repeated pages abort, empty pages are bounded, a hard page cap exists.

**Efficiency / reliability**
- Whole repo tree fetched once; unchanged files are detected by git blob SHA and **never rewritten** (re-running a sync does zero writes).
- Main README + TOPICS.md written **once** at the end of a historical sync.
- 409/stale-SHA conflicts re-fetch the latest SHA.
- Resumable job state machine with persisted discovery checkpoint, `chrome.alarms` auto-resume after the service worker is killed, long rate limits park the job and an alarm wakes it.
- Per-operation tab leases, 20 s bounded wait with backoff, automatic content-script re-injection into tabs that were open before the extension loaded.
- Real error classification (auth, rate limit, network, server, missing code, API changed, conflict, permission, config, metadata) driving retry behaviour.

**Product**
- New **Control Center** page (Overview, Historical Sync, Failed, Decisions, Repository, Diagnostics, Settings, Logs) — everything can be configured and checked there.
- **Dry run**, **Only new problems**, **Verify coverage** against LeetCode's solved list, **Rebuild index from GitHub**, **Regenerate READMEs**, real **Ask** mode (Decisions tab).
- README grouped by difficulty, verified LeetCode solved count shown separately from "synced to GitHub", topic index.
- (Superseded in 3.0.0: the editor reader and main-world script were removed.)

**Upgrade notes**: v1 history is migrated into the new solution index automatically; v1 queue/progress state is reset.
