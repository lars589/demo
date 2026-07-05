---
name: builder-claim
description: Atomically claim a GDS task by id so this session has exclusive control over it. Triggers when the user says "/builder-claim N", "claim task N", "I'll work on N", or after `/builder-start` when the user picks one. Refuses if the task is already claimed, not ready, or has unshipped dependencies. (touches[] overlap with another active claim is ADVISORY for an interactive claim — it warns, it does not refuse; task 880.)
---

**Script skill (authoritative).** The core action is `bongos claim <task-id> [--worktree NAME]`. Once the args are determined, run it and relay its output verbatim — do not paraphrase error messages or reformat the claimed card.

You are claiming a task on behalf of the current builder. The claim is atomic — either it succeeds (and the task is locked to this session) or it fails with a clear reason and the user picks differently.

## What this skill does

Runs `bongos claim <task-id> [--worktree NAME]`. The CLI hits `POST /api/gds/claims`, which transactionally:

1. Verifies the task exists and is `ready`.
2. Verifies all declared `dependencies[]` are in `shipped` status (V3.R02 / migration 020).
3. Checks `touches[]` overlap (prefix-aware) against active claims. This is **advisory** for an interactive claim — it returns an `overlap_warning` and the claim still succeeds. It is a hard `TOUCHES_CONFLICT` refusal **only** when `--enforce-touches` is passed (the autonomous `--parallel` runner). (task 880)
4. Inserts the claim row (the unique partial index gates concurrent attempts on the *same* task).
5. Flips the task to `active`.

Any failure mode comes back as a JSON error code (`TASK_NOT_FOUND`, `TASK_NOT_READY`, `DEPS_NOT_SHIPPED`, `TOUCHES_CONFLICT`, `ALREADY_CLAIMED`, the session-scoped one-claim guard `session_already_has_active_claim` (task 1642), plus V3.R13 #237's newcomer gates: `stage_required`, `newcomer_must_ship_first`). The CLI surfaces these clearly.

## One claim per session / one worktree per claim (task 1642)

A CLI session may hold **at most one active claim at a time**, and that claim should run in its **own dedicated worktree**. This is structural, not a style preference: working two tasks from one worktree lands every commit on the single branch that worktree owns, so `/builder-ship` publishes the whole branch and drags the other task's commits into the wrong ship (a *commingled ship*). One claim → one worktree → one clean branch keeps every ship isolated.

The server now **enforces** the one-claim half (task 1642): `POST /api/gds/claims` refuses a second claim when the **same session** already holds an active one, returning `409 session_already_has_active_claim` (the body names the in-flight task id + title). This is session-scoped (a builder may still run several sessions in parallel, each with its own worktree and its own single claim) and fail-closed. So the **default claim flow must put the task in a fresh worktree** — never reuse a worktree that already owns a claim.

**Default flow — claim into a dedicated worktree:**

1. **Ensure a dedicated worktree for this task** before claiming. If the harness exposes a worktree primitive (e.g. `EnterWorktree` named `task-N`), enter a worktree named for the task id so this claim gets its own branch and never reuses a busy worktree. If you are already in a clean, claim-free worktree dedicated to this task, stay in it. If the current worktree already holds another active claim, do **not** claim here — open a new worktree/session first (the server will refuse otherwise).

2. **Then claim** following the steps below, passing the worktree's leaf-folder name via `--worktree`.

## How to use

1. **Confirm the task id with the user** if they didn't give a number directly.

2. **Determine the worktree name** (cross-platform). If we're inside a worktree, the worktree name is the leaf folder of the current path. Resolve it portably with node (works on Windows/macOS/Linux — no `basename`/`$PWD` shell-isms):
   ```
   node -e "console.log(require('path').basename(process.cwd()))"
   ```
   Then pass it via `--worktree`.

3. **Run**:
   ```
   bongos claim <task-id> --worktree <worktree-name>
   ```

4. **On success**, relay the claim id, task title, version, priority, credit reward, and the `touches[]` to the user. Treat `touches[]` as an **advisory hint** at the expected blast radius — NOT an editing fence. Code legitimately wanders into files nobody predicted; that is fine and no longer ship-blocking (the grader reads the real committed diff, and `git merge` is the authoritative collision detector). If the claim returned an `overlap_warning`, relay it too — it just means another active claim declares overlapping files; the user self-serializes only if it's genuinely the same code.

   **Render the claimed card (task 1275).** _As of task 1288 the lifecycle-card `PostToolUse` hook (`.claude/hooks/lifecycle-card.js`) reads this card and injects a one-step render directive right after `claim.js` runs — normally just follow that injected directive and render **once**; the detail below is the fallback if no directive appears._ `claim.js` prints the deterministic lifecycle card for the `claimed` stage — a monospace card plus, when the builder has widgets on (the default), an `[otb-card-html] <path>` marker. If that marker is present **and** an in-feed visualization tool is available (e.g. `show_widget`), **Read that file and pass its exact contents** to the tool as `widget_code` (title like `task_<id>_claimed`); it shows the scope (priority / estimate / touches), the brief in its dropdown, and an "Open the work" action routed to the task's discipline session. **Author nothing yourself and don't restate the claim in prose** — the card is the summary. If instead you see an `[otb-card] widgets are off …` line (the builder disabled widgets via Settings → Rendering, task 1279) — or no visualization tool is available — the monospace card already printed IS the summary; relay it as-is and do not call show_widget.

5. **On `ALREADY_CLAIMED`**: another session beat us to it. Run `/builder-start` again to get a fresh list and let the user pick something else.

6. **On `TOUCHES_CONFLICT`** (only when `--enforce-touches` was passed — the autonomous `--parallel` path): the API tells us which task titles are conflicting. For a parallel run, drop this task and take the next disjoint one. (An interactive claim never hits this — it gets an `overlap_warning` and succeeds.)

7. **On `TASK_NOT_READY`**: the task has been moved to a different status. Surface the current status. The user may need to `promote` it or pick a different task.

8. **On `DEPS_NOT_SHIPPED`**: the API returns the list of unshipped deps. Surface them and tell the user to ship those first (or pick a different task whose deps are clear). Do NOT promote the dep or override — the dep system exists precisely to gate this case.

9. **On `stage_required`**: a generic onboarding-stage gate (no specific stage gates claims today — the primer gate was removed in #766). Surface `what_to_do` verbatim; don't try to force the claim.

10. **On `newcomer_must_ship_first`** (#766 newcomer focus rule): the builder is a Xenos who already holds one active claim and is trying to open a second. They must ship (or release) the current work before claiming again. The API response includes the active claim's task id and title — surface them and suggest `/builder-ship N` (or `/builder-release N` to abandon). The rule lifts automatically once they graduate to Thetes (after their 3rd shipped task).

11. **On `session_already_has_active_claim`** (task 1642 — applies to **all ranks**): this *session* already holds an active claim, and a session may hold only one (one worktree → one branch → no commingled ships). The body names `active_task_id` + `active_task_title`. Surface them with `what_to_do`: either `/builder-ship N` (or `/builder-release N`) the in-flight task first, **or** open a fresh worktree/session for this new task and claim there. Do not retry in the same worktree — the refusal is the guard working. (`session_claim_check_failed` is the rare fail-closed variant when the server couldn't verify the session state; same remedy — retry, or use a fresh session/worktree.)

## Constraints

- **Don't retry on conflict.** Failures here are intentional — they protect us from race conditions.
- **Don't claim multiple tasks in one go.** A **session** holds at most one active claim at a time (task 1642, server-enforced). If this session already has one, surface it and either ship/release it first or open a fresh worktree/session for the new task.
- **Don't bypass the API.** Direct DB writes would skip the touches-conflict check.

## Files this skill touches

- Reads: `~/.config/otb/gds-session.json`
- Calls: `POST /api/gds/claims`
