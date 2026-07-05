---
name: blocker-review
description: Daily review of open GDS blockers — surface each, prompt the user to resolve, escalate, or note continued blockage. Resolving a blocker auto-promotes any linked tasks from blocked → ready (DB trigger). Triggers when the user says "/blocker-review", "review blockers", "what's stuck on me", "what's stuck on Lars", "check blockers", or runs as a scheduled daily task. Metic+ rank only (Metic and Archon; not Xenos).
---

You are running the daily blocker-review session for Off the Boats. Open blockers in the GDS `blockers` table get surfaced one-at-a-time, with prompts for the user to take action — resolve, escalate, or confirm still-blocked.

This is the structural cure for the old "task #3 sat in `blocked` for days because nobody flipped it after the blocker was resolved" pattern. Phase 2a's BEFORE-UPDATE trigger auto-promotes linked tasks the moment a blocker is marked resolved. This skill is what makes sure resolutions actually get marked.

## Rank gate — Metic+ only

This skill is **gated to Metic and above** (Metic, Archon). It is **not** available to Xenos, the lowest rank. Resolving a blocker auto-promotes every linked task from `blocked` → `ready` via the BEFORE-UPDATE trigger — that's a write that reshapes what the whole team can claim next, so it's a trusted-builder operation. A Xenos can still **file** a blocker (`POST /api/gds/blockers`) — that path stays open to any authenticated builder — they just can't resolve or link them.

This mirrors GDS-V3 criterion C2 (`three-ranks-gate-everything`), which names "blocker review" explicitly as a Metic privilege alongside full claim/ship, idea triage, and planning/priority sessions (see [`docs/canonical-permissions.md`](../../../docs/canonical-permissions.md) and [ADR 0018](../../../docs/adr/0018-three-rank-model-goes-live.md)).

**Enforce the gate at the very top of the session, before reading anything else:**

1. Call `GET /api/gds/me` and read `builder.rank`. Compare case-insensitively (lowercase it before testing).
2. **If `rank` is present and lowercases to `xenos`** → stop immediately. Tell the builder: *"Blocker review is a Metic+ operation — resolving a blocker auto-promotes every task linked to it, which reshapes the whole team's ready queue. You're currently Xenos. You can still file a new blocker via `POST /api/gds/blockers`; ask an Archon to promote you if you need to resolve them."* Do not list open blockers, do not propose resolutions.
3. **If `rank` lowercases to `metic` or `archon`** → proceed with the steps below.
4. **If `rank` is absent** (the GET /me response has no `rank` field — only possible against a deployment where the three-rank model hasn't shipped yet): treat the session as available, exactly as `/planning-session` and `/priority-session` do in their pre-rank passthrough mode. Note in the session log that the gate ran in pre-rank passthrough mode.

> The gate is **belt-and-braces**: the server already rejects `/blockers/:id/resolve` and `/blockers/:id/link` with `403 rank_forbidden` for any non-Metic+ caller (#360 / ADR 0018), and markdown never grants authority (criterion C7). This frontmatter + check is the *intent surfaced to the operator*; the server is the *enforcement*. The skill stops early so a Xenos doesn't read the whole open-blocker list and walk through verdicts only to hit a 403 on every POST.

## What this skill does

1. Lists open blockers via `GET /api/gds/blockers`.
2. For each, prompts: **resolved**, **still blocked** (with brief status update), or **escalate** (surface to Lars or generate an external ask).
3. Resolves accordingly via `POST /api/gds/blockers/:id/resolve`. The trigger handles the linked-task flip.

## How to use

**Step 1 — fetch open blockers.**

```
bongos exec scripts/gds/api.js GET /api/gds/blockers
```

(No auth needed — `/blockers` is read-public so the build dashboard can show what's stuck on Lars. `api.js` is the cross-platform GDS API helper — runs on Windows/macOS/Linux, unlike the old `curl | python3` form.)

If the list is empty, print "no open blockers — nothing to review today" and exit.

**Step 2 — walk the list, blocker by blocker.**

Present each blocker with:
- id + title
- body_md (full)
- created_at
- blocking_task_ids[] — the tasks that auto-promote on resolution

Then ask the user (concise, plain-language; Lars is the prompter — frame around the product outcome):

> Blocker #N: "{title}". This is blocking {N} task(s): {task titles}. Status today — **resolved, still blocked, or escalate**?

**Step 3 — apply the verdict.**

**Resolved** → ask for a one-line resolution note (what unblocked it), then post
(api.js signs the request with your session token automatically):

```
bongos exec scripts/gds/api.js POST /api/gds/blockers/<id>/resolve --body '{"resolution_note":"<one-line summary>"}'
```

(If the note has characters awkward to quote in your shell, write the JSON to a temp file and use `--body-file <path>` instead.)

The response includes `promoted_tasks` — the tasks the trigger just flipped from `blocked` → `ready`. Surface these to the user so they know what's now claimable.

**Still blocked** → ask the user for a one-line "what's the latest" status. Don't write it to the DB (no field for that today — flag for a future column if useful). Just note it for the session log.

**Escalate** → ask whether the right move is:
- A team Discord broadcast via `bongos exec scripts/discord/post.js` (Discord replaced Google Chat in both directions — outbound per ADR 0032 / #607, inbound per ADR 0033 F6; `scripts/chat/` was removed 2026-06-05)
- An email/Slack/etc. that needs Lars's identity to send (in which case write a one-line ask the user can copy)
- An ADR if the blocker reflects an architectural decision someone needs to make

**Step 4 — surface a summary.**

Report to the user:
- Total reviewed
- Resolved (count + ids + the tasks each unblocked)
- Still blocked (count + brief status notes)
- Escalated (count + ids + the action being taken)

If anything was resolved, encourage the user to consider claiming one of the now-`ready` tasks if they have time today (`/builder-start` to see them).

## Why we run this daily

A blocker that resolves silently and never gets propagated keeps multiple tasks artificially stuck. Phase 2a's trigger fixes the propagation, but only IF resolutions get recorded. Daily cadence is the keep-honest mechanism — even when the answer is "still blocked," the user has a fresh data point that the situation hasn't changed (which sometimes turns into "this has been blocked too long, time to escalate").

## Tone for the user

Lars is the prompter (see CLAUDE.md §2). Some blockers are external (Stripe creds from a lawyer, fulfillment intake from Hermeslines partners). Don't pressure. The skill's job is to ask cleanly, record the answer, and surface what would unlock if Lars decided to push on a particular item today.
