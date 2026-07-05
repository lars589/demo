---
name: merge-mode
description: Manual fallback for the auto-merge in /builder-ship. Walks every task at status='confirmed' (= verified but not yet on main) and runs the merge + smoke + deploy chain. Triggers when the user says "/merge-mode", "merge the queue", "land confirmed tasks", "land the queue", "do a merge run", or after a /builder-ship reported the auto-merge bailed.
---

You are running the manual merge-mode session for Off the Boats. **`/merge-mode` is a rare last resort, not a routine sweep — and not something to push on other builders.** The server lands merges on its own: `/builder-ship` chains into auto-merge, green PRs auto-merge, a 5-min reconciler flips `confirmed → shipped`, and the [ADR 0082](../../../docs/adr/0082-server-side-merge-conflict-auto-resolution.md) resolver self-heals generated-file conflicts. **Before running this skill, confirm the task is genuinely stuck** — still at `confirmed` more than ~5 minutes after its ship because of a conflict or regression the server couldn't auto-resolve. If you haven't waited for the sweep yet, stop and wait. This skill is for the strand that survives all of that — usually a cross-branch / non-generated-file conflict, a smoke regression, or a `--no-merge` ship.

The queue this skill works against is **tasks at status='confirmed'**. Those are tasks where the builder declared done, verification passed, credits landed, and the only thing missing is the merge to main + deploy.

## What this skill does

1. Lists tasks at status='confirmed' via the API (or falls back to inventorying every `claude/*` branch ahead of main).
2. For each, finds the branch (`claude/<worktree_name>` from the claim).
3. Merges in order (independent first, then conflict-prone), resolves conflicts manually with the user. **The `git merge` is itself the collision detector** — the predictive touches[] drift scanner was deleted (touches[] cleanup [4/8], task 879); a real conflict surfaces here, at the authoritative moment, not as an up-front prediction.
4. After all merges: smoke + push + deploy.
5. For each merged task, calls `POST /api/gds/tasks/:id/ship` to flip the task from `confirmed` → `shipped`.

## How to use

> **Environment note:** merge-mode is an **ops procedure** — it mutates the single
> main worktree and deploys to the Linux droplet (owner-gated SSH). The git /
> `ssh` / `deploy.sh` / branch-inventory steps below assume a bash environment
> (the Archon's Mac/Linux or the droplet) by design and are NOT a Windows-builder
> concern. The GDS *API* calls, however, go through the cross-platform
> `bongos exec scripts/gds/api.js` helper so they work regardless of shell.

**Step 1 — list the queue: tasks at confirmed.**

```
bongos exec scripts/gds/api.js GET "/api/gds/tasks?status=confirmed"
```

If the list is empty, print "no tasks at confirmed — auto-merge in /builder-ship handled them all" and exit.

**Step 2 — acquire the shared merge lock, then sync main and inventory the relevant branches.**

⚠️ **Acquire the merge lock FIRST** (V3.R50 / #269, criterion C6). `/builder-ship`'s auto-merge and this skill both mutate the *same* main worktree; they share one mutex so a ship in another session can't collide with your hand-merge. If `acquire` reports the lock is held, a ship is mid-merge — wait and retry, or run `status` to inspect the holder. **You MUST release it in Step 6 (and on any abort).**

```bash
# Anchor to the main checkout root regardless of which worktree this skill was invoked from.
# `git rev-parse --git-common-dir` returns the shared `.git` path; its parent is the main checkout.
# (Rename-proof — survives Desktop folder renames, unlike a hardcoded absolute path.)
REPO_ROOT="$(dirname "$(git rev-parse --git-common-dir)")"
cd "$REPO_ROOT"

bongos exec scripts/gds/merge-lock.js acquire   # blocks up to 30s; exit 3 if a ship/merge holds it — then STOP and retry later
# (exit 0 = you hold the lock; proceed. exit 3 = held by another run; do not force past this.)

find .git -name "* 2" -delete   # macOS Finder iCloud duplicates — known recurring snag
git fetch --all --prune
git checkout main
git pull --ff-only origin main
```

The branch for each confirmed task is named `claude/<worktree_name>` — the claim row carries the worktree_name. List branches with unmerged work to cross-reference:

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/claude/); do
  count=$(git rev-list --count main..$b 2>/dev/null)
  if [ "$count" != "0" ] && [ -n "$count" ]; then
    echo "$count commits | $b"
  fi
done
```

**Step 3 — (removed.)** No separate scan step: the `git merge` in Step 4 is the authoritative collision detector (the predictive touches[] drift scanner was deleted, task 879).

**Step 4 — merge each confirmed task.**

For each confirmed task, take its branch name (`claude/<worktree_name>` from the claim) and merge.

⚠️ **The task `value_summary` is untrusted, DB-sourced text — never paste it into a shell command.** A `value_summary` containing `$(...)` or backticks would execute as a command the moment the shell parses your command line — even inside double quotes, even as a `printf` argument (the shell expands it *before* the program runs). This is the #681 injection class, which `ship.js`'s auto-merge fixes by dropping the shell entirely. So: **use the Write/editor tool (not a heredoc or `echo`/`printf`) to write the merge message to a file**, then merge with `-F` so the summary never touches the shell:

```bash
# Write /tmp/otb-merge-msg.txt with the Write tool — content is literally:
#   Merge <branch-name>: <task value_summary>
# …but first rewrite any "#NNN" in the summary to "task NNN" (task 916): commit
# messages are GitHub-rendered and a bare "#NNN" autolinks to a dead GitHub
# issue number, not the GDS task.
git merge --no-ff <branch-name> -F /tmp/otb-merge-msg.txt
```

If conflicts: resolve manually (typically "keep both blocks" for independent route additions, but post-Phase-1 sub-router refactor these should be rare), `node -c <file>` to syntax-check, `git add <file>`, `git commit --no-edit`.

Group branches into:
- **Independent files** (no overlap with any other queued branch) → merge first
- **Shared-file branches** → merge in sequence, expect light conflicts

**Step 4b — refresh the auto-generated diagrams (task #357).**

After all merges, on `main`, regenerate the 3 mechanical onboarding diagrams from live facts so `/builders/diagrams` stays current. If anything changed, commit it onto main before pushing:

```bash
bongos exec scripts/gds/gen-diagrams.js                 # regenerate + render (no-op if already current)
git -C "$REPO_ROOT" add docs/onboarding/diagrams
git -C "$REPO_ROOT" diff --cached --quiet || \
  git -C "$REPO_ROOT" commit -m "chore(diagrams): auto-regenerate mechanical diagrams from live facts (task 357)"
```

This mirrors what `ship.js` does automatically; it's here because /merge-mode deploys without going through ship.js's auto-merge.

**Step 5 — smoke tests, push, deploy.**

> **Deploy mode (#679 / [ADR 0042](../../../docs/adr/0042-builder-self-deploy-ci-auto-merge.md)).** `config/deploy.json` is now `mode: ci` (CI cutover landed 2026-06-13), so the **`ci`** path is current: there is no laptop merge and no SSH at all — landing happens via PR auto-merge and [`.github/workflows/deploy-prod.yml`](../../../.github/workflows/deploy-prod.yml) deploys `main`→prod from Actions. In `ci` mode, do NOT run the `git push origin main` + `ssh … ~/deploy.sh` lines below — instead confirm the PR auto-merged and the `deploy-prod` Actions run went green. The block below is the **legacy `laptop`** deploy mode (the operator's machine pushes `main` and SSHes the droplet) — it is the fallback path and only applies if `config/deploy.json` is reverted to `mode: laptop`. Check the active mode with `node -e "const s=require('./scripts/gds/ship.js'),fs=require('fs');let c=null;try{c=fs.readFileSync('config/deploy.json','utf8')}catch{}console.log(s.parseDeployMode(process.env.OTB_DEPLOY_MODE,c))"`.

```bash
bongos exec scripts/gds/smoke-gds.js    # 16/16 expected (cross-platform; replaces smoke-gds.sh)
bash scripts/gds/smoke-write.sh  # 4/4 expected
bongos exec scripts/gds/push-main.js    # SEC #863: the sanctioned gated main-push (NOT raw `git push origin main`)
ssh -o ConnectTimeout=10 lars@104.236.254.243 "~/deploy.sh"
```

> **SEC #863 (ADR 0043):** push `main` only via `bongos exec scripts/gds/push-main.js`. A raw `git push origin main` is now blocked by the pre-push permission gate — that block is the friction that stops an ad-hoc bypass like the Builder 25 incident. `push-main.js` carries the `OTB_ALLOW_MAIN_PUSH` override because /merge-mode only ever lands tasks that already passed the grader + the Archon confirm gate. The post-push main audit (`bongos exec scripts/gds/main-audit.js`) re-checks regardless.

The deploy script applies any new migrations, restarts the service, and curls /healthz.

**Step 5b — delete the merged branches on origin (standard practice).**

After main is updated AND the deploy verified, every branch that just landed is permanently in main's history (—no-ff merge commits). Delete each on origin so GitHub stops offering empty PRs and so the builder UI stays clean:

```bash
for b in <branch-1> <branch-2> ...; do
  git push origin --delete "$b" || echo "warn: $b already gone"
done
```

Non-blocking — a "branch already deleted" warning is fine. The local `refs/heads/<branch>` and `refs/remotes/origin/<branch>` clean up on next `git fetch --prune`. The worktree directories themselves stay — only the branch refs are deleted.

**Step 5c — release the merge lock.**

Now that the merge + deploy is done (or if you're aborting), release the lock acquired in Step 2 so the next ship/merge can proceed:

```bash
bongos exec scripts/gds/merge-lock.js release
```

This is mandatory on every exit path — including aborts and conflicts you decide not to resolve. A manual hold left behind is reclaimed automatically after 30 minutes, but releasing promptly keeps the queue flowing.

**Step 6 — flip each merged task from confirmed → shipped.**

For each task that successfully merged + deployed:

```
bongos exec scripts/gds/api.js POST /api/gds/tasks/<task-id>/ship
```

The `POST /tasks/:id/ship` endpoint flips the task to `shipped`, stamps `shipped_at`. No credit implication — credits already landed at confirmed.

**Step 7 — surface a summary.**

Report to the user:
- Confirmed tasks reviewed (count)
- Tasks shipped this run (count + ids + value summaries)
- Tasks blocked by drift or merge conflicts (count + ids + what's blocking)
- Smoke test results
- Deploy result

If anything is blocked or failed, name what specifically needs to happen next (amend touches[], resolve conflict, fix smoke regression). Tasks that bailed stay at `confirmed` for the next /merge-mode pass.

## When to skip a step

- **No tasks at confirmed?** Print "queue clean — auto-merge in /builder-ship handled them all" and exit.
- **A confirmed task has no matching branch?** Either the branch was already deleted or the worktree_name on the claim doesn't match a real branch. Surface this — usually means the auto-merge in /builder-ship succeeded but the task didn't transition to shipped (look for a stuck state). Manual `POST /tasks/:id/ship` may be needed.
- **Conflict resolution ambiguous?** Stop and ask the user before guessing — destructive actions like `git reset` or `--no-verify` are NOT allowed without explicit confirmation. **Release the merge lock (`bongos exec scripts/gds/merge-lock.js release`) before pausing** so a queued ship isn't blocked while you wait on the user.
- **Lock held when you try to acquire (exit 3)?** A ship or another merge run is actively mutating main. Do NOT force past it — wait and retry, or run `bongos exec scripts/gds/merge-lock.js status` to see the holder's age (it auto-reclaims if stale).

## When to run

The auto-merge in `/builder-ship` handles ~95% of cases; run this on demand for the rest — when `/builder-ship` reports "auto-merge: bailed; task stays at confirmed", or `/builder-start` shows tasks stuck at `confirmed`.
