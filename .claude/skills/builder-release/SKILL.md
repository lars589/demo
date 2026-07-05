---
name: builder-release
description: Cancel an active claim without shipping. The task returns to 'ready' status, no credits are awarded, and the work is freed for another builder. Triggers when the user says "/builder-release N", "cancel my claim", "I'm dropping this task", "give it back". Captures a brief reason in the session log.
---

**Script skill (authoritative).** The core action is `bongos release <task-id> --reason "..."`. Once the task id and reason are determined, run it and print its output verbatim — do not editorialize the result.

You are releasing a task on behalf of the current builder. Releasing is the honest "I started this, but I'm not finishing it right now" exit.

## What this skill does

Runs `bongos release <task-id> --reason "..."`.

The CLI hits `POST /api/gds/claims/:id/resolve` with `outcome: 'abandoned'`, which transactionally:
1. Marks the claim `released_at = now`, outcome `abandoned`.
2. Flips the task status back to `ready`.
3. Inserts a `session_logs` row with the reason and timestamps.
4. Awards no credits.

The task is immediately claimable by another session.

## How to use

1. **Determine the task id and reason.** If the user said "/builder-release N", the task id is N. If no reason was given, ask for one phrase — even "out of time" is enough.
   - Release vs. ship-as-partial: Release = "reset cleanly, no progress to record." Ship-as-partial = "I made progress; use `/builder-ship` with partial notes instead."

2. **Run**:
   ```bash
   bongos release <task-id> --reason "the reason"
   ```
   Print the output verbatim.

## Constraints

- **Don't release reflexively when blocked.** If the blocker is real and persistent, surface it to Lars AND promote it to a blockers entry.
- **Don't shame.** Releasing is a normal, healthy operation.

## Files this skill touches

- Reads: `~/.config/otb/gds-session.json`
- Calls: `GET /api/gds/me`, `POST /api/gds/claims/:id/resolve`
