---
name: builder-end
description: One command to safely close out a Claude Code session — resolve the active claim (ship or release), verify the git tree is clean so nothing is lost, tear down this session's worktree, and (on a dev box) offer to shut the box down. Triggers when the user says "/builder-end", "close out my session", "close out my online terminal session", "end my session", "sign off", "wrap up and clean up", "I'm done for now, clean up", or "ship/release this and tear down the worktree". This is the session close-out a builder reaches for via /builder-exit — that one offboards a whole builder and is Archon-only; this is the everyday own-scoped close-out. Own-scoped: only this session's own claim + own worktree + own box.
---

You are closing out the current Claude Code **session** safely: resolve the held claim, confirm no work is stranded uncommitted, and clean up the session's git worktree. It is the bookend to `/builder-start` — one command so a session ends in a known-clean state instead of leaving a half-shipped claim and an orphaned worktree behind.

This is **not** `/builder-exit` — that deactivates an entire builder (releases all claims, drops rank to Xenos). `/builder-end` is the everyday "I'm done with this session" close-out for one session's one claim.

## What this skill does

Composes operations that already exist, in a safe order, with the destructive ones gated last:

1. **Resolve the claim** — `/builder-ship` when there's committed, shippable work; `/builder-release` when there isn't. (It calls the sibling skills; it does not re-implement shipping.)
2. **Clean-git verify** — refuse to go further if any *tracked* file is uncommitted. This is the same guard `scripts/gds/ship.js` enforces (`trackedDirty` in [`src/bongos/ship-preflight.js`](../../../src/bongos/ship-preflight.js)): untracked scratch is ignored, but a modified/staged/deleted tracked file means real work isn't committed — stop before anything is lost.
3. **Worktree teardown** — from the main checkout, `git worktree remove` this session's linked worktree, `prune`, and delete the now-merged `claude/<name>` branch.
4. **Box close-out (dev box only)** — if running on a dev box (`/etc/otb/box.env` exists), offer to `close-box` so the box stops billing. Optional and gated on a yes; declining just lets the box idle-park. On a laptop this step is skipped — there's no box to close.

It never pushes to `main`, never `ssh`-es, never runs a deploy — landing is `/builder-ship`'s job (server-mediated). It only ever touches the caller's **own** claim, **own** worktree, and **own** box.

## How to use

### 0. Snapshot the session state — read, don't mutate yet

- **Held claim(s):** `bongos exec scripts/gds/api.js GET /api/gds/me` → `active_claims`. (A builder can hold parallel claims across sessions; resolve only the one this session worked.)
- **Are we in a linked worktree?** `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir` ⇒ yes (`--git-dir` is the per-worktree `<main>/.git/worktrees/<name>`; `--git-common-dir` is the shared `<main>/.git`); they're equal ⇒ main checkout (skip step 3). Test `--git-dir`, **not** `--git-common-dir` — the latter always returns the shared `<main>/.git` even inside a worktree, so checking *it* for `/worktrees/` never matches.
- **Are we on a dev box?** `/etc/otb/box.env` exists ⇒ yes. This is the codebase's canonical "am I on a box?" marker — written by `box.js provision`, the same presence-check `scripts/gds/sandbox-stage.js` (`isDevBox`) uses. On a box the close-out has an extra step: the box keeps billing until it's shut down or idle-parks (step 4). On a laptop there's no box — skip step 4.
- **Working-tree state:** `git status --porcelain`.
- **Commits ahead of main:** `git rev-list --count main..HEAD` (fall back to `origin/main..HEAD`). Real commits ⇒ likely shippable; zero ⇒ likely a release.

### 1. Resolve the claim

- **Commits ahead AND clean tree ⇒ shippable.** Confirm with the user, then run the **`builder-ship`** skill with honest handoff `--notes` and a one-line non-jargon `--summary`. Don't fabricate the summary — if you can't state the value plainly, it isn't shippable; release instead.
- **No commits / no shippable progress ⇒** run the **`builder-release`** skill with a one-phrase reason.
- **No active claim ⇒** nothing to resolve; go to step 2.
- **Ship strands at `confirmed`** (merge conflict or a failing check — the box ships, the merge doesn't): **stop here.** The branch still needs to land via `/merge-mode`. Surface that and do NOT tear down the worktree — its branch isn't merged yet (step 3's `git branch -d` would correctly refuse it).

### 2. Clean-git verify

Re-run `git status --porcelain`. Apply the `trackedDirty` rule: ignore `??` untracked lines, but if **any** tracked file is modified/staged/deleted/renamed/unmerged, **stop** and surface those files so the user can commit or discard them. Never tear down a worktree that still holds uncommitted tracked work — that is exactly how work gets lost.

### 3. Worktree teardown — gated, and last

Proceed only when **all** hold: we're in a linked worktree, the claim is resolved, the tree is clean, and (for a ship) the branch is merged into `main`.

You can't remove the worktree you're standing in, so run the removal **from the main checkout** — resolve its path the way `ship.js` does (`findMainWorktree`: parse `git worktree list --porcelain` for the block whose `branch` is `main`). From there:

```bash
git worktree remove <this-worktree-path>   # refuses if dirty — that's the safety net; do not --force
git worktree prune
git branch -d claude/<worktree-name>        # -d (not -D): git refuses an unmerged branch, by design
```

Removing this session's worktree ends its filesystem — do it last, and tell the user the session is closed and they can start fresh from `/builder-start` anytime. **On a dev box, settle step 4 first:** if the builder is going to `close-box`, skip teardown entirely — deprovisioning destroys the whole `/workspace` disk, so removing one worktree first is wasted effort. Only tear the worktree down if they're keeping the box.

**On the main checkout (not a worktree):** skip the teardown above — there's nothing to remove. On a **laptop** that means resolving the claim + clean-git verify is the whole close-out. On a **dev box** (step 0 found `/etc/otb/box.env`) the box itself is still up — continue to step 4.

### 4. Box close-out — dev box only, gated, after the claim is resolved

Skip this entirely if step 0 found no `/etc/otb/box.env` (a laptop — there's no box to close). On a box, resolving the claim does **not** stop the box billing; only closing it (or the idle-suspend sweep) does. Once the claim is resolved and the tree is clean, ask plainly:

> *"Close the box down too? `close-box` deprovisions it — anything in `/workspace` you haven't shipped is gone. Or leave it: closing the tab keeps your session, and the box idle-parks on its own (cheap)."*

- **Yes, shut it down** → run the **`close-box`** skill (`bongos exec scripts/gds/api.js POST /api/gds/box/close`). It enqueues a deprovision that runs within ~a minute. This **subsumes** worktree teardown — the whole box disk is going away, so step 3 was moot.
- **No, keep the box** → leave it; it idle-parks automatically. The close-out is complete (claim resolved, worktree torn down in step 3 if applicable). Tell them they can reopen the terminal to resume, or `/builder-box` to check/wake it later.

`close-box` is **own-scoped** — it only ever deprovisions the caller's own box. Never another builder's.

## Constraints

- **Own-scoped.** Only this session's claim, this session's worktree, and the caller's own box — never another builder's claim, never another worktree, never `git worktree remove` a path you didn't create, never another builder's box.
- **Never destroy uncommitted work.** The clean-git verify gates teardown; `git worktree remove` (no `--force`) and `git branch -d` (not `-D`) are the load-bearing safety nets — keep them as written.
- **Box close is opt-in and destructive.** On a box, never `close-box` without an explicit yes — it deprovisions the box and any unshipped `/workspace` work is gone. Declining is always fine; the box idle-parks on its own.
- **Never push / ssh / deploy.** Landing goes through `/builder-ship` (server-mediated); this skill stays local to the builder's machine (its one possible API write is the opt-in own-scoped `close-box`).
- **The destructive steps (teardown, box-close) never run unattended without a clear go.** Ship vs. release can be inferred from state (commits ⇒ ship, none ⇒ release) and proceed; removing the worktree ends the session and closing the box destroys it, so wait for an explicit yes before steps 3 and 4.
- **Don't tear down a branch that isn't merged.** A released task or a ship stuck at `confirmed` still has an un-landed `claude/*` branch — `git branch -d` will refuse it; respect that and leave the worktree for `/merge-mode`.

## Files this skill touches

- Reads: `~/.config/otb/gds-session.json`; `/etc/otb/box.env` (presence check only — "am I on a box?")
- Runs: the `builder-ship` / `builder-release` skills (`scripts/gds/ship.js` · `release.js`), `bongos exec scripts/gds/api.js GET /api/gds/me`, and local `git worktree` / `git status` / `git branch` commands. On a dev box, if the builder opts in, it runs the `close-box` skill (`POST /api/gds/box/close`) — the one own-scoped API write it can make; otherwise it makes no API writes of its own.
