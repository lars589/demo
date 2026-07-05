---
name: idea-triage
description: Daily walk through the GDS idea_inbox — for each open idea, prompt to promote (→ task), discard, or merge with another idea. Triggers when the user says "/idea-triage", "triage ideas", "review the inbox", "walk the idea inbox", or runs as a scheduled daily task. Metic+ rank only (Metic and Archon; not Xenos).
---

You are running the daily idea-triage session for Off the Boats. Open ideas in the GDS `idea_inbox` table get walked one-at-a-time and verdicted, so the inbox doesn't accumulate stale entries.

## Rank gate — Metic+ only

**Gated to Metic+ (Metic, Archon); not Xenos.** Triage verdicts (promote, discard, merge) reshape the team's backlog — a trusted-builder operation (GDS-V3 criterion C2, `three-ranks-gate-everything`; [`docs/canonical-permissions.md`](../../../docs/canonical-permissions.md), [ADR 0018](../../../docs/adr/0018-three-rank-model-goes-live.md)). A Xenos can still **file** an idea (`POST /api/gds/inbox`); they just can't verdict them.

**Enforce the gate at the very top of the session, before reading anything else:**

1. Call `GET /api/gds/me` and read `builder.rank`. Compare case-insensitively (lowercase it before testing).
2. **If `rank` is present and lowercases to `xenos`** → stop immediately. Tell the builder: *"Idea triage is a Metic+ operation — promoting, discarding, or merging an idea reshapes the team's backlog. You're currently Xenos. You can still file a new idea via `POST /api/gds/inbox`; ask an Archon to promote you if you need to triage them."* Do not list open ideas, do not propose verdicts.
3. **If `rank` lowercases to `metic` or `archon`** → proceed with the steps below.
4. **If `rank` is absent** (the GET /me response has no `rank` field — only possible against a deployment where the three-rank model hasn't shipped yet): treat the session as available, exactly as `/planning-session` and `/priority-session` do in their pre-rank passthrough mode. Note in the session log that the gate ran in pre-rank passthrough mode.

> Belt-and-braces: the server already rejects `PATCH /inbox/:id` with `403 rank_forbidden` for non-Metic+ callers (#360 / ADR 0018) — this check just stops a Xenos early instead of after a whole walk of 403s. Markdown never grants authority (criterion C7).

## What this skill does

1. Lists open ideas via `GET /api/gds/inbox`.
2. **Develops the open ideas in parallel** — spawns one subagent per idea (the Agent tool) that fleshes the one-liner out into a structured *open-questions / challenges / risks* block, so the Archon verdicts on a developed idea instead of a bare title (task 930).
3. For each, prompts the user with: **promote** (create a task and link it), **discard** (closed, no action), or **merge** (this duplicates idea N, mark merged into N).
4. Updates each idea via `PATCH /api/gds/inbox/:id` with the verdict.

## How to use

**Step 1 — fetch the open inbox.**

```
bongos exec scripts/gds/api.js GET /api/gds/inbox
```

(`api.js` is the cross-platform GDS API helper — it signs the request with your
session token and runs on Windows/macOS/Linux, replacing the old `python3`/`curl`
block. For a human at a terminal, `bongos exec scripts/gds/triage.js` runs the whole
walk interactively instead.)

If `open_count` is 0, print "inbox empty — nothing to triage today" and exit.

**Step 1.5 — develop the open ideas in parallel (task 930).**

Before walking the list, **flesh out each open idea with a subagent** so the verdict lands on a developed idea, not a one-liner. Spawn the subagents **in parallel** (multiple `Agent` tool calls in a single message) — they run while you prepare the walk, so there's no serial wait.

- **Model:** `opus` for every development subagent. This is research / design analysis against the live repo, which per CLAUDE.md §2's routing table is Opus work — never inherit silently, never downgrade to Haiku.
- **Fan-out cap:** develop up to **12** ideas per session (oldest-first — `captured_at` ascending). If there are more than 12 open, note "developed the 12 oldest; the rest are walked undeveloped" so nothing is silently dropped.
- **One idea per subagent.** Give each subagent the idea's `id`, `title`, `body_md`, `kind`, and `captured_by`, and this instruction:

  > Flesh out this Off the Boats idea for an Archon triage verdict. Read the relevant code/docs to ground yourself (start from CLAUDE.md and the surfaces the idea touches). Return ONLY a JSON object with these keys: `summary` (one sentence, what integrating it actually means), `integration_surfaces` (array of files/areas it would touch), `open_questions` (array — the decisions a human must make before this can be a task), `challenges` (array — what's hard or unclear), `risks` (array — what could break or regress), `rough_effort` (one of `S`/`M`/`L`), `recommendation` (one of `promote`, `discard`, `merge:#<id>`, `needs-info`). Keep each array item to one line. Do not invent surfaces you didn't verify exist.

- **Collect the results into a development cache** keyed by idea id and write it to a temp file so the deterministic walker can also surface it:

  ```json
  { "generated_at": "<ISO>", "ideas": { "228": { "summary": "...", "integration_surfaces": ["..."], "open_questions": ["..."], "challenges": ["..."], "risks": ["..."], "rough_effort": "M", "recommendation": "needs-info" } } }
  ```

  Write it to `${TMPDIR:-/tmp}/otb-idea-development.json` (Windows: `%TEMP%\otb-idea-development.json`). A subagent that fails or returns unparseable JSON is simply omitted from the cache — that idea is walked undeveloped, not blocked.

If a human will run the interactive walker instead of the Claude-driven walk below, hand it the cache:

```
bongos exec scripts/gds/triage.js --development "${TMPDIR:-/tmp}/otb-idea-development.json"
```

`triage.js` prints each idea's developed block above its verdict prompt. It never *generates* the analysis (that's this skill's subagent fan-out) — it only displays what the cache holds, and runs exactly as before when no cache is present.

> **Not in this cut (follow-up leg).** The next step is to let the Archon push the developed `open_questions` *back to the submitter* — a round-trip in the Discord `#ideas` thread / DM before promotion — so the submitter says how they'd want it integrated. That needs the Discord bot interaction + idea↔thread linking (idea #216 / [ADR 0033](../../../docs/adr/0033-discord-bot-service-principal.md)) and is tracked separately. For now the open questions are answered by the Archon in-session.

**Step 2 — walk the list, idea by idea.**

Present each idea with:
- id + kind (auto-classified by B2)
- title
- body_md (full)
- captured_at + captured_by
- **its developed block** (from Step 1.5): summary, integration surfaces, open questions, challenges, risks, rough effort, and the subagent's recommendation

Then ask the user (concise prompt — Lars is an EE, not a software engineer; frame in product/outcome terms). Lead with the developed open questions, since those are what the Archon actually needs to decide:

> Idea #N: "{title}". {one-sentence developed summary}. **Open questions:** {the subagent's open_questions}. **Promote, discard, or merge with another idea?**

**Step 3 — apply the verdict.**

**Promote → pick the tier (BV1.R64 / ADR 0086).** An idea no longer only becomes a *task* — it can promote into any tier of the work hierarchy: a **goal** (a whole module-scoped workspace), a **criterion** (a new done-when test), or a **task** (a single unit of work). Choose by the idea's size: a broad objective → goal; a "we should also require X to be done" → criterion; a concrete piece of work → task. Frame the choice to the user in those terms, then create the right record and mark the idea promoted.

- **Promote → task** (the common case). Ask for version, title, est_minutes, priority, credits_reward (`touches[]` optional — [ADR 0049](../../../docs/adr/0049-split-parallel-safety-contract.md)). (Filing a task *under a goal* — stamping `tasks.goal_id` — is the bounded-authoring route's job, R60; until it lands, promote to a task at the version level and link it to a goal's criteria via `criterion_ids`.)

  ```
  # 1. Create the task (--body-file avoids shell-quoting the touches[]/description).
  bongos exec scripts/gds/api.js POST /api/gds/tasks --body-file <path-to-task.json>
  #    task.json: {"version_id":"...","title":"...","description":"...","touches":[...],
  #    "est_minutes":N,"priority":N,"credits_reward":N,"source":"idea_inbox","source_ref":"idea:<idea_id>"}
  # 2. Mark the idea promoted, pointing promoted_to_task_id at the new task id.
  bongos exec scripts/gds/api.js PATCH /api/gds/inbox/<idea_id> --body '{"status":"promoted","promoted_to_task_id":<new_task_id>}'
  ```

- **Promote → goal** (Metic+; Archon if the scope includes a `protected` module). Create the goal, then mark the idea promoted — `promoted_to_task_id` stays NULL (a goal isn't a task; note the new goal id in the session log, mirroring how criterion-promotion records its link).

  ```
  bongos exec scripts/gds/api.js POST /api/gds/goals --body '{"version_id":"<ver>","title":"...","description":"from idea #<idea_id>","scope_modules":["<module-key>", ...]}'
  bongos exec scripts/gds/api.js PATCH /api/gds/inbox/<idea_id> --body '{"status":"promoted"}'
  ```

- **Promote → criterion** (Archon — done-when writes are scope-shaping, criterion C2). This reuses the existing ratify path: the idea must be `kind='criterion-proposal'` with a `body_md` JSON of `{target_version, criterion_md, sort_order_hint}` (the `/planning-session` shape). One atomic call both inserts the criterion and marks the idea promoted:

  ```
  bongos exec scripts/gds/api.js POST /api/gds/inbox/<idea_id>/ratify --body '{"notes_md":"ratified via idea-triage"}'
  ```

  If the idea isn't already criterion-proposal-shaped, either re-file it in that shape or promote it to a task/goal instead — don't hand-write a `done_when_criteria` row.

**Discard** → mark it closed:

```
bongos exec scripts/gds/api.js PATCH /api/gds/inbox/<idea_id> --body '{"status":"discarded"}'
```

**Merge** → ask the user which other idea N is the canonical one, then mark this one merged:

```
bongos exec scripts/gds/api.js PATCH /api/gds/inbox/<idea_id> --body '{"status":"merged","promoted_to_task_id":<canonical_idea_or_task_id>}'
```

**Defer** is implicit — leave the idea open by not patching it. Inbox count stays the same; the idea will surface again tomorrow.

**Step 4 — surface a summary.**

Report to the user:
- Total walked
- Promoted (count + new task ids)
- Discarded (count + ids)
- Merged (count + ids)
- Deferred (count + ids — these will surface again next session)
- New inbox open_count

## Why we run this daily

Daily cadence keeps the inbox actionable. If the user is busy, a fast pass with mostly "defer" verdicts beats skipping the session — the cadence is the discipline, not the volume of decisions.

## Tone for the user

Lars is the prompter (see CLAUDE.md §2). Frame promotion decisions in terms of product outcome, not implementation: "this would let the player resume after refresh" not "this would add a localStorage hook." Decide the implementation details yourself when promoting.
