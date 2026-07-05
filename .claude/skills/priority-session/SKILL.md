---
name: priority-session
description: Run a structured priority session — a trusted builder answers a handful of plain-speech questions, and the answers reweight the GDS idea_inbox and suggest what to claim next. Triggers when the user says "/priority-session", "run a priority session", "what should I work on next", "reprioritize the inbox", "what feels most important right now", or "help me decide what to claim". Metic+ rank only (Metic and Archon; not Xenos).
---

You are running a **priority session** for the Game Development System (GDS). Where a **planning session** sets a *version's* scope (criteria + a fresh ranked task list), a priority session works the *present tense*: it takes the open `idea_inbox` exactly as it stands and reweights it against how the builder actually feels about the work right now — what's stuck, what would unblock the most people, what they're excited to build. The session ends with a **weighted ranking of the open ideas** and a single **"what should I claim next?"** suggestion, and it writes a durable session-log entry so the reweighting is on the audit trail.

This is the live-flight complement to `/planning-session`: planning sessions set a version's scope; priority sessions reweight the present queue when the builder isn't sure where to point their energy.

## Rank gate — Metic+ only

**Gated to Metic+ (Metic, Archon); not Xenos.** Reweighting the whole team's inbox is a trusted-builder operation (GDS-V3 criterion C2, `three-ranks-gate-everything`).

**Enforce the gate at the very top of the session, before reading anything else:**

1. Call `GET /api/gds/me` and read `builder.rank`. Compare case-insensitively (lowercase it before testing) — the `builders.rank` enum casing is defined by V3.R04; until it ships, normalize defensively.
2. **If `rank` is present and lowercases to `xenos`** → stop immediately. Tell the builder: *"Priority sessions are a Metic+ operation — they reweight the whole team's idea queue. You're currently Xenos. Ask an Archon to promote you, then run this again."* Do not read the inbox, do not propose a ranking.
3. **If `rank` lowercases to `metic` or `archon`** → proceed.
4. **If `rank` is absent** (the server-enforced rank system — V3.R04 / criterion C7 — has not shipped yet, so `/me` returns no `rank` field): treat the session as available, exactly as `/planning-session` does today ("available to all builders for now; rank-gates to Metic+ at end of V3"). Note in the session-log entry that the gate ran in pre-rank passthrough mode. The moment `builders.rank` lands, this skill enforces it for real with no edit — the check above already reads the field.

> The gate is the *intent* surfaced to the operator; the server is the *enforcement* — markdown never grants authority (criterion C7).

## When to invoke

- The builder asks "what should I work on next?" and the claimable list is long enough that rank-by-priority alone isn't a clear answer.
- The open `idea_inbox` has grown and the team's sense of what matters has drifted from the priorities filed weeks ago.
- A builder is starting a work block and wants to point their energy at the thing that's both high-leverage *and* something they're motivated to do.

## When NOT to invoke

- **To set a version's scope** — that's `/planning-session`. Priority sessions never write criteria or create the version's task spine.
- **To verdict the inbox** (promote / discard / merge each idea) — that's `/idea-triage`. A priority session *ranks* open ideas; it doesn't close them. The two are complementary: triage keeps the inbox clean, priority sessions tell you which clean idea to grab first.
- **For a Xenos** — see the rank gate above.
- **When the inbox is empty** — there's nothing to reweight. Fall back to `/builder-start` to surface claimable tasks and pick by standard priority.

## The session — four phases

### Phase 1 — Pull the present state

Read everything the reweighting depends on. Do this before asking the builder anything, so their answers land against real data, not guesses.

1. `GET /api/gds/me` — rank gate (above) **and** the builder's `active_claims` (don't suggest claiming something they already hold) and `total_credits`.
2. `GET /api/gds/inbox` — the open ideas. This is the set you will rank. Capture each idea's `id`, `title`, `body_md`, `kind`, `suggested_version`, `suggested_priority`, `captured_at`, `captured_by`.
3. `GET /api/gds/tasks/claimable` — what's *actually claimable right now* (deps shipped, parallel-safe). The "what should I claim next?" answer must come from this list, never from an idea that hasn't been promoted to a task yet.
4. `GET /api/gds/blockers` (read-public, no auth) — open blockers. An idea that would resolve or route around a current blocker scores higher on the "unblock the most builders" axis.

If `open_count` is 0, print *"inbox empty — nothing to reprioritize. Running `/builder-start` instead to surface claimable tasks."* and stop the priority flow.

**Surface a compact summary back** before the questions: N open ideas (grouped by kind), M claimable tasks, K open blockers, the builder's current claims. This is the canvas they're about to reweight.

### Phase 2 — The plain-speech questions

Ask the builder a short set of **5–7 plain-language questions**, one at a time or as a single block (let them answer however they like). These are *feelings about the work*, not implementation questions — Lars is the prompter (CLAUDE.md §2): frame around outcomes and motivation, never around design patterns. Keep each question to one sentence.

Ask these (you may lightly reword for tone, but keep the intent):

1. **What feels stuck?** — Which area of the project keeps not moving, or keeps coming up and getting deferred?
2. **What would unblock the most builders?** — If you fixed one thing, what would free up the most other work for the whole team?
3. **What excites you right now?** — What would you actually *enjoy* building this block? (Motivation is a real multiplier — a builder ships faster on work they want to do.)
4. **What's the most expensive thing to keep ignoring?** — What's quietly accruing cost, risk, or debt the longer we leave it?
5. **What would a player or a watching builder notice this week?** — What's the highest-visibility win available right now?
6. **What's risky if we get it wrong later?** — Is there a decision or foundation that's cheap to set right now and painful to unwind once built on?
7. **How much time and energy do you have this block?** — Quick wins, or room to sink into something deep? (This shapes the *claim* suggestion, not the ranking.)

You don't have to ask all seven if the builder's first answers already cover the field — but ask at least five, and always ask #1, #2, #3, and #7 (those four directly feed the weights below and the claim suggestion). Capture the answers verbatim; you'll cite them in the session log.

### Phase 3 — Weight and rank

Turn the answers into a transparent score per open idea, then present the ranking.

**Scoring model.** Score each open idea 0–5 on each of four axes, then blend. The axes map directly onto the questions so the builder can see *why* an idea moved:

| Axis | Fed by | What earns a high score |
|---|---|---|
| **Stuck / momentum** | Q1 | The idea targets an area the builder named as stuck or repeatedly deferred. |
| **Leverage / unblocks** | Q2, blockers list | The idea unblocks other tasks or resolves/routes around an open blocker. Cross-check `blockers` and any task `dependencies[]` the idea would clear. |
| **Excitement / motivation** | Q3 | The idea is in or near the area the builder said excites them. |
| **Cost-of-delay / risk** | Q4, Q6 | The idea targets accruing cost, risk, or a cheap-now/expensive-later decision. |

`score = 1.0·stuck + 1.2·leverage + 0.8·excitement + 1.0·cost_of_delay`

Leverage is weighted highest because unblocking the team is the strongest team-level signal; excitement is weighted slightly lower because it's a personal multiplier, not a team priority — but it stays in the blend deliberately, since a motivated builder ships. Start from each idea's existing `suggested_priority` as a faint prior (break ties with it), but let the answers dominate — the whole point of the session is that today's felt priorities override stale filed ones.

**Present the ranking** as a numbered list, highest score first. For each idea show: rank, `#id`, title, the blended score, the per-axis breakdown (e.g. `stuck 4 · leverage 5 · excite 2 · cost 3`), and a one-line *why it ranked here* that quotes the relevant answer. Numbering lets the builder reorder by number — *"bump 3 above 1, drop 5"* — the same edit-by-number convention `/planning-session` and `/idea-triage` use.

**Let the builder adjust.** Ask: *"Anything mis-ranked? Reorder, or tell me an axis I read wrong."* Re-blend if they push back — their override wins. This is a human session; the model is a starting point, not a verdict.

**Persisting the reweighting — not yet wired.** A priority session's ranking lives in the **session-log entry** (Phase 4), not in a mutated inbox. The `idea_inbox` `PATCH` route (`src/bongos/routes/inbox.js` / `inbox.updateIdea()`) currently only accepts `status`, `kind`, `promoted_to_task_id`, and `reviewed_at` — it does **not** accept `suggested_priority`, so a `PATCH` trying to bump it would return 200 but change nothing (a silent no-op). Do **not** attempt it. If the builder wants the new order to durably stick in the inbox, that's a follow-up: file an `idea_inbox` row (`kind='skill-friction'`) asking to add `suggested_priority` to the inbox PATCH allowlist so a future priority session can persist its ranking. Until that ships, the log entry is the canonical record of the reweight.

### Phase 4 — "What should I claim next?" + land the log

**Make the claim suggestion.** This is the single most useful output. Cross the ranking against `GET /api/gds/tasks/claimable` and the builder's Q7 (time/energy):

- The top-ranked idea is only a valid claim suggestion **if it's already a claimable task**. An open idea is *not* claimable — it's an idea. If the top idea hasn't been promoted to a task yet, say so and offer: *"This isn't a task yet — want me to promote it via `/idea-triage`, or claim the highest-ranked thing that's already a task?"*
- Filter claimable tasks by the ranking's themes and by Q7: if the builder said "quick win," prefer low `est_minutes`; if "deep block," prefer the high-leverage foundational work even if it's bigger.
- Never suggest something in the builder's `active_claims`.
- Present **one** primary suggestion with a one-line rationale tying it to their answers, plus 1–2 runners-up. End with the exact command: `bongos claim <id> --worktree <name>` (or `/builder-claim <id>`).

**Write the session-log entry.** A priority session is a real decision on the audit trail — record it. Write `docs/session-logs/YYYY-MM-DD-priority-session.md` (append a numeric suffix if one already exists today) containing:

- Date, builder (`github_login` + rank, or "pre-rank passthrough"), credits at session start.
- The 5–7 questions asked and the builder's answers verbatim.
- The full weighted ranking with per-axis scores.
- Any `suggested_priority` writes made (idea id → new value).
- The claim suggestion and whether the builder took it.

Prepend a one-line link to the CLAUDE.md §13 Session Log index (newest at top), matching the format of the existing entries. Per-entry prose stays in the dated file, not in CLAUDE.md — same discipline as every other session.

## How to use — quick reference

```bash
# Auth: cli-lib.js resolves the session token (new path gds-session.json,
# legacy fallback pms-session.json) and signs every request. Prefer driving the
# API through it rather than re-deriving the token inline.
node -e "const {apiCall}=require('./scripts/gds/cli-lib.js'); \
  apiCall('GET','/api/gds/me').then(r=>console.log(JSON.stringify(r.data,null,2)))"

# Phase 1 — pull state
node -e "const {apiCall}=require('./scripts/gds/cli-lib.js'); \
  apiCall('GET','/api/gds/inbox').then(r=>console.log(JSON.stringify(r.data,null,2)))"
node -e "const {apiCall}=require('./scripts/gds/cli-lib.js'); \
  apiCall('GET','/api/gds/tasks/claimable').then(r=>console.log(JSON.stringify(r.data,null,2)))"
node -e "const {apiCall}=require('./scripts/gds/cli-lib.js'); \
  apiCall('GET','/api/gds/blockers').then(r=>console.log(JSON.stringify(r.data,null,2)))"   # read-public

# Phase 4 — the suggestion resolves to a real claim command
bongos claim <task_id> --worktree <worktree-name>
```

The read shapes (`/inbox` → `{ ideas, open_count }`, `/me` → `{ builder, active_claims }`) are the same ones `/idea-triage` and `/planning-session` use. Mirror those read patterns rather than inventing new ones. There is no priority-session write to the inbox today — see "Persisting the reweighting — not yet wired" above.

## Tone for the user

Lars is the prompter (CLAUDE.md §2 — EE background, not a software engineer). The questions are deliberately plain-speech: ask about feelings, outcomes, and what he'd actually enjoy, never about implementation. Decide the scoring and the claim mechanics yourself; present the ranking and the one suggestion for confirmation. When he overrides a rank, take it — the session exists to capture *his* present-tense priorities, and the model is just scaffolding for that conversation.
