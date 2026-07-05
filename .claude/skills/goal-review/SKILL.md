---
name: goal-review
description: Walk the GDS criterion review queue — for each criterion auto-flagged "met — pending review" (all its tasks shipped, not yet confirmed), prompt to confirm (→ satisfied), reject (not actually met), or note/defer. Confirming a goal's LAST criterion auto-flips the goal open→achieved. Triggers when the user says "/goal-review", "review goals", "review flagged criteria", "what criteria are ready to confirm", "confirm criteria", "walk the goal review queue", or runs as a scheduled daily task. Metic+ rank only (Metic and Archon; not Xenos).
---

You are running the **goal-review** session for this Cloud Bongos instance. It mirrors `/idea-triage`, but for the *closing* end of the work hierarchy (ADR 0086 §6): criteria that have **auto-flagged "met — pending review"** get walked one-at-a-time and dispositioned, so finished work actually closes out instead of sitting in limbo.

**The auto-flag is derived, not stored.** When every task linked to a criterion has shipped — and the criterion has not yet been confirmed — the server flags it `pending_review` (deterministic from `task_criteria` + ship status; no manual propose step). This skill surfaces that queue and lets a trusted builder confirm or reject each one. Confirming sets the criterion `satisfied=true`; confirming a goal's **last** unsatisfied criterion auto-flips the goal `open → achieved`.

## Rank gate — Metic+ only

**Gated to Metic+ (Metic, Archon); not Xenos.** Confirming a criterion sets `satisfied=true` and can auto-achieve a goal — a trusted-builder operation that closes out a slice of a version (the "who confirms" resolution in ADR 0086 §6: the planner, not only the Archon). The server enforces this — `POST /api/gds/done-when/:criterionId/satisfy` is `requireRank('metic','archon')` and pinned in `route-rank-check.EXPECTED_RANKS` — so this check just stops a Xenos early instead of after a wall of 403s. Markdown never grants authority ([`docs/canonical-permissions.md`](../../../docs/canonical-permissions.md), [ADR 0016](../../../docs/adr/0016-trust-boundary-server-enforced-permissions.md)).

**Enforce the gate at the very top of the session, before reading anything else:**

1. Call `bongos exec scripts/gds/api.js GET /api/gds/me` and read `builder.rank`. Compare case-insensitively (lowercase it before testing).
2. **If `rank` lowercases to `xenos`** → stop immediately. Tell the builder: *"Goal review is a Metic+ operation — confirming a criterion closes out a slice of a version and can auto-achieve a goal. You're currently Xenos. Ask an Archon to promote you if you need to confirm criteria."* Do not list the queue, do not propose verdicts.
3. **If `rank` lowercases to `metic` or `archon`** → proceed with the steps below.
4. **If `rank` is absent** (a deployment where the three-rank model hasn't shipped) → treat the session as available, exactly as `/idea-triage` does in its pre-rank passthrough mode, and note that in the session log.

## What this skill does

1. Lists flagged criteria via `GET /api/gds/done-when/pending-review` (optionally `?version=<id>`).
2. For each, prompts the user with: **confirm** (the criterion is genuinely met → mark satisfied), **reject** (the tasks shipped but the criterion is NOT actually met → leave it open and capture why), or **note / defer** (leave it flagged; it resurfaces next session).
3. Applies confirm via `POST /api/gds/done-when/:criterionId/satisfy` — and reports any goal that auto-achieved as a result.

## How to use

**Step 1 — fetch the review queue.**

```
bongos exec scripts/gds/api.js GET /api/gds/done-when/pending-review
```

(Add `?version=BONGOS-V1` to scope to one version. `api.js` is the cross-platform GDS API helper — it signs the request with your session token.)

If `count` is 0, print "review queue empty — no criteria pending review today" and exit.

Each row carries: `id` (the criterion's numeric id — what you POST to), `criterion_id` (the slug) + `criterion_md` (the prose), `version_id`, `goal_id` + `goal_title` + `goal_status`, `task_total` (how many shipped tasks fulfilled it), and **`is_last_in_goal`** — `true` when this is the goal's only remaining unsatisfied criterion, so **confirming it will auto-achieve the goal**.

**Step 2 — walk the list, criterion by criterion.**

Present each criterion with: its `criterion_md`, its goal (`goal_title`), how many tasks shipped under it (`task_total`), and — when `is_last_in_goal` is true — a clear flag:

> ⚠️ This is the LAST open criterion in **{goal_title}** — confirming it will mark the whole goal **achieved**.

Then ask the user (concise; frame in product/outcome terms — Lars is an EE, not a software engineer):

> Criterion C{n} — "{criterion_md}". {task_total} task(s) shipped under it. **Confirm it's met, reject (not actually done), or defer?**

**Step 3 — apply the verdict.**

**Confirm** → mark it satisfied. Optionally pass the ship-task that fulfilled it:

```
bongos exec scripts/gds/api.js POST /api/gds/done-when/<criterion_id>/satisfy --body '{}'
# or, to record which task fulfilled it:
bongos exec scripts/gds/api.js POST /api/gds/done-when/<criterion_id>/satisfy --body '{"satisfied_by_task_id":<task_id>}'
```

The response is `{ criterion, goal_achieved, goal }`. **If `goal_achieved` is true**, announce it: *"🎯 Goal '{goal.title}' is now achieved — all its criteria are confirmed."* (That goal now awaits disposition — see Step 4.)

**Reject** → the criterion's tasks all shipped, but on review it is **not actually met** (the work missed something, or "done" was mis-scoped). There is no "unsatisfy the flag" — the flag is *derived* from shipped tasks, so the durable fix is to **add the missing work**: capture what's still needed (a follow-up task linked to this criterion, or an idea via `bongos exec scripts/gds/capture.js "..."`), and note the rejection in the session log. Once an unshipped task is linked to the criterion, it drops out of `pending_review` on its own. If no follow-up is filed, the criterion simply stays flagged and resurfaces next session — an honest signal that a human said "not done" but nothing was queued to close the gap. **Do not confirm a criterion you would not stake the version on.**

**Note / defer** is implicit — leave the criterion un-confirmed by not POSTing. It stays in the queue and surfaces again next session (same as `/idea-triage`'s defer).

**Step 4 — achieved goals (disposition).**

Any goal that flipped to `achieved` this session (or is already `achieved`) awaits a disposition: **archive** it (done, put it to rest) or **carry it forward** into the next version's scope. Surface each newly-achieved goal to the user and record the intended disposition in the session log.

> The archive / reopen / carry-forward **actions** (the routes that mutate goal lifecycle) land in **BV1.R64** ([task 1518](https://amazonprimea.com/builders#/task/1518)) — they are not wired here. For this session, *report* achieved goals and capture the intent; once R64 ships, this step gains the verbs to execute it.

**Step 5 — surface a summary.**

Report to the user:
- Total criteria walked
- Confirmed (count + ids)
- Goals auto-achieved (count + titles)
- Rejected (count + ids + what follow-up was filed)
- Deferred (count + ids — these surface again next session)
- New queue `count`

## Why we run this

Without a closing cadence, criteria pile up "done but unconfirmed" and goals never flip to achieved — the version looks perpetually in-progress even when the work has shipped. A fast pass keeps the rollup honest. As with `/idea-triage`, the cadence is the discipline; a quick walk with mostly defers beats skipping it.

## Tone for the user

Lars is the prompter (see CLAUDE.md §2). Frame each decision in terms of outcome — "this criterion was 'players see each other'; both tasks shipped — is that actually true in the live game?" not "flip satisfied=true on criterion 45." Decide the mechanics yourself; ask him only about whether the thing is *really* done.
