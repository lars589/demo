---
name: status
description: Answer "what's the status of X" / "what's left for criterion Cn" in one call. Triggers when the user says "/status", "what's left for C8", "status of GDS-V3", "how far along is the memory criterion", "what tasks remain to complete X", or asks how a version/criterion is progressing. Read-only — rolls up each done-when criterion → its gating tasks → live statuses → what's blocking.
---

You are answering a project-status question. Before this skill existed, doing so meant ~10 sequential GDS calls (grep the seed file for which tasks map to a criterion, eyeball a "Gates R55–R63" sentence, then re-query each task's status). The structured criterion↔task link (`task_criteria`, migration 055) + the `/status` CLI collapse that to one call. See ADR 0025 and task #435.

## What this skill does

Rolls up a version's done-when criteria → gating tasks → live statuses → what's left, in one call to the public `GET /api/gds/versions/:id/progress`. Read-only and unauthenticated, so it works even before `/builder-setup`. As of task 1288 it produces a **deterministic card** (same shape every time) — your job is to render it, not to re-summarize it.

## How to render it

Delivery is deterministic (task 1288, same methodology as `/builder-start`). The **card-delivery hook** (`.claude/hooks/session-cards.js`) runs `status.js` for you on a `/status` (or "what's left for C8" / "status of GDS-V4") prompt — pulling any version + `Cn` out of the prompt — and injects the **finished card + a one-step directive** into your context, a block beginning `[otb card — the status card below was pre-rendered …]`.

1. **Normal path — follow the injected directive.** If that `[otb card …]` block is present, do exactly what it says: `show_widget` with the fenced HTML if you have `mcp__visualize` (call `mcp__visualize__read_me` once first, silently), otherwise output the fenced markdown **verbatim**. Render **once** — don't run `status.js`, don't lead with your own headline, don't rebuild the table, don't add a recommendation or recap. The card now owns the headline, the remaining-task list, and the unattributed-tasks note (this replaces the old freeform "interpret + relay" summary).

2. **Fallback — no directive present** (hook disabled/failed, or an older checkout). Run it yourself:
   - **If you have `show_widget`**: `bongos status --widget [--version ID] [Cn]` → render the HTML verbatim with `title: "status_card"` (call `read_me` once first).
   - **No widget renderer**: `bongos status [--version ID] [Cn]` → print its stdout verbatim.
   - `Cn` is positional (C8 = the 8th criterion); `--version` defaults to the live internal version; `--json` is the machine interface; `--hook` is the envelope the hook consumes — don't render those for the user unless asked.

## Constraints

- **Read-only.** This skill never claims, ships, or mutates anything. If the user then wants to act on a remaining task, hand off to `/builder-claim N`.
- **`Cn` is positional**, computed live from the criteria ordering — so it stays correct even if criteria are added or reordered. Don't hardcode a Cn→slug mapping.
- If `--version X` returns no criteria, say so plainly (that version may not have done-when criteria seeded) rather than implying 0% done.

## Files this skill touches

- Calls: `GET /api/gds/versions/:id/progress` (public)
- Runs: `scripts/gds/status.js` (`--hook` / `--widget` render the card; default text + `--json` unchanged)
- Delivered by: `.claude/hooks/session-cards.js` (the card-delivery hook, task 1288)
