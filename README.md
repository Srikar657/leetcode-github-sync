# LeetHub (v3.0) — your LeetCode progress, saved to GitHub automatically

A Chrome extension (Manifest V3). It is a **personal LeetCode progress dashboard** — problems solved, today's progress, streaks, difficulty, topics, languages, acceptance rate, activity — that quietly saves every solved problem to a GitHub repository in the background.

> ## USER SUBMITS. LEETCODE CONFIRMS. LEETHUB SAVES.
> The extension **never** clicks, presses, triggers or simulates LeetCode's Submit (or Run) button, never submits code through an API, and contains **no code whose purpose is to submit**. It is a passive observer. Your attempts, acceptance rate and submission history only ever change when *you* act on LeetCode. A test in the suite scans the entire source and fails the build if any such code ever appears.

## How a solve is detected and saved

```
You write code and submit on LeetCode, as usual
        ↓
LeetCode judges it                               (the extension only watches)
        ↓
Not Accepted → recorded as an attempt (acceptance rate), nothing saved
Accepted     →
        ↓  1. fetch THAT submission's detail: status code + the exact code that was judged
        ↓  2. LeetCode itself must now mark the problem as solved
        ↓  3. dashboard updates immediately (solved, today, streak, topics, languages…)
        ↓  4. the exact accepted code is queued and saved to GitHub in the background
```

- **Passive detection.** On a problem page the extension remembers the problem's *existing* submissions (a baseline) and then, every few seconds while the tab is visible, reads the latest ones. A submission that is not in the baseline is yours, made just now. Opening the page, refreshing, switching tabs or restarting Chrome therefore can never cause a submission *or* a re-save. It does not rely on a button click, and "Run → all test cases passed" is never looked at.
- **Exact code.** The saved code is the code of the accepted submission (by submission id) — never whatever is currently in the editor.
- **LeetCode state and GitHub state are separate.** The problem is *solved* because LeetCode says so. GitHub saving is a queued job (`pending → saving → saved`, or `failed` with a Retry). A GitHub outage never un-solves anything; saves retry automatically with backoff and survive Chrome stopping the extension's background worker.
- **No duplicates.** A submission id is saved once; identical code is never rewritten; a *new* accepted submission of an already-solved problem updates GitHub according to your "existing file" setting.

## What the popup and dashboard show

The **popup is deliberately small**: problems solved, +today, Easy/Medium/Hard, today's progress, your last three solves and the GitHub status. The **Dashboard** (popup → Dashboard) has the full picture; the table below describes it.

Everything is computed from real activity — nothing is hard-coded.

| Section | Definition |
|---|---|
| Problems solved | distinct problems with an Accepted submission (or listed as solved by LeetCode) |
| +N today | problems whose *first* acceptance is today (re-solving an old problem doesn't raise the total) |
| Today's progress | distinct problems accepted today / submissions today / not accepted; progress bar if you set a daily goal (default: no goal) |
| Current streak | consecutive days with ≥1 accepted problem, ending today — **or yesterday**, so it isn't reset before you've had a chance to solve today |
| Longest streak | best run of consecutive active days |
| Easy / Medium / Hard | solved problems by difficulty |
| Topics | every topic of every solved problem (a 3Sum solve raises Array, Two Pointers *and* Sorting); click a topic to list its problems |
| Languages | distinct solved problems per language (Python3 shown as Python) |
| Acceptance rate | accepted ÷ submissions with a known result; failed submissions never count as solved |
| This week / month | Monday–Sunday and calendar month: solved, submissions, acceptance, best day |
| Activity | 16-week heatmap |
| Recent activity | newest solves; click to open on LeetCode; a small dot shows a pending/failed GitHub save |
| Live status | "Checking submission…", Accepted, Wrong Answer, Time Limit Exceeded… plus the separate GitHub line |

A small **read-only** status panel also appears on LeetCode problem pages (it has no buttons that act on LeetCode; hide it in Settings).

**First run:** open the Dashboard and press **Import full history** once (keep a logged-in LeetCode tab open). After that, numbers update by themselves; a cheap incremental refresh runs at most every 30 minutes and never opens tabs on its own.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the extension's **Control Center** (click the toolbar icon → *Open Control Center*).
3. **Settings** → enter owner, repository, branch and a fine-grained token → **Save** → **Test connection**.
4. Log into leetcode.com in any tab.
5. **Diagnostics** → *Run all checks*. Everything should be PASS (WARN on optional items is fine).

See `SETUP.md` for the token walk-through.

## Getting your old solutions into GitHub (optional, in Dashboard → Historical Sync)

1. **Diagnostics** → fix any FAIL.
2. **Historical Sync** → tick **Dry run** → **Start**. Review the report: what would be created, what is not accepted, what failed. Nothing is written.
3. Try one problem first: Overview → *Sync this problem* (e.g. `two-sum`) and look at your repo.
4. **Historical Sync** → untick Dry run → **Start** (or press *Looks good — sync for real*, which reuses the scan).
5. **Repository** → **Check coverage**: compares LeetCode's own solved list with the repo and lists anything missing; *Sync missing problems now* fills the gaps.

A full run takes a few minutes for ~200 problems (it is deliberately polite to LeetCode and GitHub). You can close the Control Center; the job continues in the background and resumes by itself if Chrome stops the extension worker. If you are rate-limited it waits and resumes automatically.

## Repository layout

```
Easy/0001-two-sum/solution.py      one file per language
Easy/0001-two-sum/solution.cpp
Easy/0001-two-sum/README.md        lists all languages for the problem
Medium/0002-add-two-numbers/...
README.md                          generated section between LEETCODE-SYNC markers
TOPICS.md                          problems grouped by topic
```

- **Languages:** the same problem in Python and C++ produces two files — intentionally. Python and Python3 share `solution.py`; SQL dialects get distinct names (`solution.mysql.sql`). An unrecognized language is saved as `solution.<name>.txt` and flagged.
- **Which submission:** per problem *and* language you keep the most recent Accepted submission (or the first, in Settings).
- Text you write in `README.md` outside the markers is never touched.

## Dashboard tabs

| Tab | What it does |
|---|---|
| Progress | the full analytics dashboard, topic drill-down, searchable/filterable list of solved problems |
| Historical Sync | start / pause / resume / cancel, dry run, only-new, live progress, downloadable report |
| GitHub saves | saves/syncs that need attention (with Retry); the problem stays solved |
| Decisions | the real **Ask** mode: differing files wait here for Overwrite / Keep |
| Repository | coverage check, rebuild index from GitHub, regenerate READMEs, synced-problem table |
| Diagnostics | independent read-only checks of GitHub and LeetCode, with fix hints |
| Settings | GitHub connection, daily goal, panel on/off, behaviour options, reset local data |
| Logs | recent log (tokens and source code are never logged) |

## Privacy & security

- Token: stored only in `chrome.storage.local`, sent only to `api.github.com`, never shown again, never logged, removable with **Disconnect**. Use a fine-grained token scoped to one repo (*Contents: Read and write*) with an expiry.
- LeetCode: the extension never asks for or reads your password/session cookie. Requests run **inside your leetcode.com tab** with your own session.
- All dashboard content is inserted with `textContent` (no `innerHTML`), so LeetCode text cannot inject markup.
- Only these hosts are accessed: `leetcode.com`, `api.github.com`.

## Development

```
npm test        # 65 end-to-end tests against fake LeetCode + GitHub servers
npm run check   # syntax check every file
```
The tests load the real extension files into sandboxed contexts wired together with a fake `chrome.*` bus. They include the "never submits" source scan, passive detection, restart/refresh safety, GitHub-outage retries, the stats definitions, and the reported failure (`statusDisplay: null`), pagination faults, 409 conflicts, rate limits, service-worker kills, expiry of the LeetCode session, and dry-run/zero-write guarantees.

## Known limits (honest list)

- LeetCode's endpoints are internal and can change. The extension is built to tolerate that (multiple sources, query variants, detail verification), and **Diagnostics** tells you exactly which part broke — but a future change may still need a code fix in `src/leetcode/submissions.js`.
- GitHub **OAuth** is not implemented (it needs a registered OAuth app/client id). A fine-grained, single-repo, expiring token is the supported method.
- Only `leetcode.com` is supported (not `leetcode.cn`).
- Repositories with more than ~100,000 files make GitHub truncate the file listing; the extension then falls back to slower per-file lookups.
