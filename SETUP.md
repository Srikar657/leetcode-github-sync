# Setup

## 1. Create the GitHub repository
Create an empty **private or public** repository (e.g. `leetcode-solutions`) and **initialize it with a README** — the branch must exist before the first sync.

## 2. Create a fine-grained token
GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*
- Expiration: 90 days (renew when it expires)
- Repository access: **Only select repositories** → your solutions repo
- Repository permissions: **Contents → Read and write** (everything else: no access)

## 3. Connect
Dashboard → Settings → owner, repository, branch, token → **Save** → **Test connection**.
You should see *"✓ owner/repo @ main"* and no write-access warning.

## 4. Load the extension
`chrome://extensions` → Developer mode → Load unpacked → this folder. After updating the files, click the reload icon on the extension and refresh any open LeetCode tabs (the extension also re-injects itself automatically when needed).

## Troubleshooting
| Symptom | Fix |
|---|---|
| Diagnostics: *LeetCode login* FAIL | Log into leetcode.com in a tab, re-run |
| *Cloudflare check* message | Open leetcode.com, complete the check, press Resume |
| Test connection: "branch not found" | Initialize the repo with a README / fix branch name |
| Test connection: no write access | Token needs *Contents: Read and write* on that repo |
| Many "Not accepted" in a dry run | Expected for problems you never solved; check *Diagnostics → Submission detail* shows a status |
| Sync stopped with *waiting* | GitHub rate limit; it resumes automatically |

## Daily use
1. Solve and submit on LeetCode exactly as you always do — the extension never submits for you.
2. When LeetCode shows Accepted, the dashboard updates and the solution is saved to GitHub within seconds.
3. First time only: Dashboard → Progress → **Import full history** to load your past activity.
