---
name: planning-session
description: Run a structured planning session for an upcoming GDS version — set scope criteria, brainstorm tasks, rank them, and upload everything to the GDS in one atomic shot. Triggers when the user says "/planning-session", "open a planning session", "let's plan V[N]", "plan the next version", or "scope a new version". Metic+ rank only (Metic and Archon; not Xenos).
---

You are running a planning session for the Game Development System (GDS). The goal is to leave the session with: (a) a clear set of done-when criteria for a version, (b) a ranked task list that lives in the GDS database, and (c) a durable record of the session for the audit trail.

The first planning session — V3 Planning Session #1, 2026-05-12 — is the template this skill encodes. See `docs/session-logs/2026-05-12-pms-v3-planning-session-1.md` for the precedent and `tasks/227` (V3.R00) for the meta-task pattern.

## When to invoke

- The user says "let's plan V4" / "plan the next version" / "open a planning session"
- A version is in `status='planning'` and needs scope locked before tasks start landing in earnest
- A previous planning session left proposals in `idea_inbox` tagged `kind='criterion-proposal'` that need ratification

## When NOT to invoke

- Mid-version: planning sessions set scope, they don't refine it. For mid-version adjustments, use `/idea-triage`.
- Without a clear target version: ask the user which version is being planned before doing anything else.
- For a task-level scope question: that's a normal task description, not a planning session.

## Rank gate — Metic+ only

This skill is **gated to Metic and above** (Metic, Archon). It is **not** available to Xenos, the lowest rank. A planning session sets the scope-truth of a version: the criteria all subsequent tasks anchor to, the dependency graph other builders inherit, the rank ordering the queue surfaces. That's a trusted-builder operation, not something a sandboxed Xenos should reshape on their own.

This mirrors GDS-V3 criterion C2 (`three-ranks-gate-everything`) and matches the gate the sibling skills already enforce (see [`docs/canonical-permissions.md`](../../../docs/canonical-permissions.md), [ADR 0018](../../../docs/adr/0018-three-rank-model-goes-live.md), and the existing rank-gate frontmatter in [`/idea-triage`](../idea-triage/SKILL.md) and [`/blocker-review`](../blocker-review/SKILL.md)).

**Enforce the gate at the very top of the session, before reading anything else:**

1. Call `GET /api/gds/me` and read `builder.rank`. Compare case-insensitively (lowercase it before testing).
2. **If `rank` is present and lowercases to `xenos`** → stop immediately. Tell the builder: *"Planning sessions set the scope-truth of a version — they're a Metic+ operation. You're currently Xenos. You can still **file** a criterion proposal or task idea via `POST /api/gds/inbox` (which lands in idea_inbox for an Archon to ratify at the next planning session); ask an Archon for promotion if you need to run sessions directly."* Do not pull state, do not present criteria, do not propose tasks.
3. **If `rank` lowercases to `metic`** → proceed in **Metic-mode**: run the five-phase structure below conversationally, but in Phase 5 write proposals to `idea_inbox` (kind=`criterion-proposal` for criteria, kind=`feature` for tasks) tagged with the target version. Archon ratifies at the next Archon-mode planning session. Do NOT write `done_when_criteria` rows or POST to `/tasks` directly — those are Archon writes.

   **For each criterion proposal**, write `body_md` as a JSON object with this exact shape so the `POST /api/gds/inbox/:id/ratify` endpoint (V3.R31 / #252) can parse it cleanly:

   ```json
   {
     "target_version": "<ver>",
     "criterion_md": "Full markdown of the criterion as it should appear in done_when_criteria.criterion_md.",
     "sort_order_hint": 200
   }
   ```

   `target_version` is required and must match an existing `versions.id`. `criterion_md` is required and is the user-visible criterion text. `sort_order_hint` is optional — omit or pass `null` to let the ratify endpoint default it to `max(existing sort_order) + 1` on the target version. On ratify, the proposer earns +5 karma (`reason='proposal_ratified'`) and the audit row in `criterion_proposal_audit` captures the full provenance.

   **Net-new version a Metic can't create yet (idea 425).** The Metic-mode path above assumes the target version *already exists* — its criterion proposals carry `suggested_version` (an FK to a `versions` row) and a `target_version` that must match `versions.id`. But version creation is **Archon-gated**: a Metic planning a *brand-new* version (one with no `versions` row yet) has no valid FK to point at, so the normal proposal can't land. When that's the case, run the session in Metic-mode as usual through Phases 1–4, then in Phase 5 file the proposals like this instead:

   1. **OMIT `suggested_version` on every proposal row.** It is an FK to a version row that doesn't exist yet; leaving it set would fail the constraint (or worse, attach the proposal to the wrong existing version). Leave it `null`/absent.
   2. **Keep `target_version` INSIDE the criterion-proposal `body_md` JSON as plain text** (the version's intended id/slug, e.g. `"V4"`). It is *not* validated as an FK there — it's a label the Archon reads at ratify time. Once the Archon creates the real version row, the proposal is ratifiable as-is: `POST /api/gds/inbox/:id/ratify` resolves `target_version` against the now-existing `versions.id`.
   3. **File ONE umbrella feature idea** (`kind='feature'`) that captures the whole net-new version in a single inbox row: the proposed version (id/slug + one-line theme), its goals, and a seed spec (the agreed criteria + the brainstormed task list). This is the thing an Archon picks up to actually create the version, then ratify the criterion proposals against it. One umbrella idea — not one idea per task — keeps the net-new version reviewable as a single unit.

   Tell the Metic plainly: *"This version doesn't exist yet, and creating a version is an Archon step. I've filed your criteria as proposals (with the version name kept as text inside each) plus one umbrella idea describing the whole version. An Archon creates the version row, then ratifies these against it — your karma and attribution carry through."*
4. **If `rank` lowercases to `archon`** → proceed in **Archon-mode**: full session, Phase 5 writes the migration + tasks + dependencies + done_when_criteria atomically. This is the flow described below.
5. **If `rank` is absent** (the `/me` response has no `rank` field — only possible against a deployment where the three-rank model hasn't shipped yet): treat the session as Archon-mode, exactly as `/idea-triage` does in its pre-rank passthrough mode. Note in the session log that the gate ran in pre-rank passthrough mode.

> The gate is **belt-and-braces**: the server already rejects `POST /api/gds/tasks`, `POST /tasks/:id/dependencies`, and `POST /done-when/:id/satisfy` with `403 rank_forbidden` for non-Archon callers, and `POST /api/gds/inbox` with `kind='criterion-proposal'` is gated to Metic+ (so a Xenos can't slip a criterion proposal in via raw curl). This frontmatter + check is the *intent surfaced to the operator*; the server is the *enforcement*. The skill stops early so a Xenos doesn't walk through a whole session only to hit 403s on every write in Phase 5.

## The session — five phases

### Phase 1 — Set the table

1. **Confirm the target version.** Pull `GET /api/gds/public/versions`. If the user didn't name one, list versions in `status='planning'` and ask which.
2. **Pull what's already queued for that version:**
   - `GET /api/gds/tasks?version=<id>` — every task already bound to the version
   - `GET /api/gds/inbox` (filter `suggested_version=<id>` or `status=open` if no suggested-version filter is supported by the route)
   - `GET /api/gds/versions/<id>/done-when` — any criteria already seeded
3. **Surface the signal back to the user** as a compact summary:
   - N tasks already queued, grouped by kind
   - M open ideas tagged for this version
   - Existing `done_when` text (often a placeholder)
   - The carry-forward limits from the previous version's `limitations/<prev>-shipped.md`

This is where the user sees what they're shaping. Do not skip this — criteria written without it are guesswork.

4. **Rescope — carry achieved goals forward (ADR 0086 §6 / BV1.R64).** If this version succeeds a prior one, pull the prior version's **achieved** goals and decide, per goal, "previous or new":

   ```
   bongos exec scripts/gds/api.js GET "/api/gds/goals?version=<prev>&status=achieved"
   ```

   - **Carry forward** — the goal's objective continues into this version. Create the successor goal in Phase 5 with `succeeds_goal_id` pointing at the prior goal (`POST /goals` stamps the predecessor's `succeeded_by_goal_id`), then **archive the prior goal** (`POST /goals/:id/archive`). The lineage stays queryable.
   - **Replace / retire** — the objective is done or superseded. Leave the prior goal achieved (or archive it) and define fresh goals in Phase 2.5.

   Surface the list to the user and get a per-goal carry/replace decision before writing criteria — the carry-forward goals shape this version's goal set.

### Phase 2 — Criteria

Criteria are the version's done-when. Strong criteria are **outcomes** (broad enough to anchor many tasks), not **task lists** (so narrow they only anchor a few). Five to nine criteria is the typical band; ours have been 7-9.

For each criterion:

- One bold lead sentence stating the outcome
- A short "why" — what changes when this is true
- 4-7 sub-outcomes that make the criterion testable

**Apply the strength test BEFORE presenting each criterion.** A criterion passes the test if it plausibly anchors at least 5 tasks across multiple `kind` values (feature + bug + infra, not just feature). If it only anchors 1-3 specific tasks, or reads like an implementation step, rewrite it as the resulting outcome before showing it to the user.

**Number every criterion** (`1.`, `2.`, …) in the presented list. The user will reference them by number when editing — e.g. "edit 4, remove 5, add a new one about X" — so they don't have to copy/paste the criterion titles.

**Ask "what's missing?" before finalizing.** Once you've presented N criteria and worked through edits, explicitly prompt: "What concerns you that I haven't named? What's missing from this list?"

Once criteria are agreed:

- Number them in final order
- Confirm each one with the user
- Get explicit sign-off before moving to brainstorming.

### Phase 2.5 — Goals (the module-scoped workspaces) — ADR 0086

A **goal** is the tier between version and criteria: a shared, joinable, **module-scoped** workspace that several builders work inside (ADR 0086). A version is "done" when all its goals are achieved. Defining goals is now part of planning — it's how the version's criteria get grouped into workspaces with a **scope wall** that bounds what each goal's members may author.

For the version being planned, **group the agreed criteria into goals**. For each goal decide, with the user:

- **Title** — the outcome the goal owns (often 1–3 criteria's worth).
- **`scope_modules`** — the module **keys** (NOT file paths) whose files this goal's members may touch. **This is the wall, and it is set here and only here — never self-granted.** Keep it tight: the modules the goal's work actually needs. Widening later goes through an explicit request a trusted rank approves (`POST /goals/:id/scope`; Archon for a `protected` module) — BV1.R64.
  > **The valid key list is the source of truth in [`src/bongos/module-scope-map.js`](../../../src/bongos/module-scope-map.js) — read it, don't trust this list.** It exports `moduleKeys()` (all keys), `protectedModules()` / `isProtectedModule(key)` (which are PROTECTED), and `scopeForModule(key)` (a key's globs + `protected` flag). Each key maps to path-globs; `protected` is **derived** (the key's globs overlap the trust/ship-pipeline/migration/authz core), and a goal scoped to any protected key is **Archon-only** to create. The current roster (run `node -e "const m=require('./src/bongos/module-scope-map');console.log(m.moduleKeys().map(k=>k+(m.isProtectedModule(k)?' 🔒':'')).join('\n'))"` to print it live):
  >   - `kernel` 🔒 · `lifecycle` 🔒 · `economy` · `grading` 🔒 · `memory` · `onboarding` 🔒 · `ideas` · `builder-settings` 🔒 · `sessions` · `autonomy` 🔒 · `security` · `hall-ui` · `status-ui` · `game` · `art-pipeline` · `discord` · `dev-box` 🔒
  >   - 🔒 = **protected** (Archon-only goal creation + Archon-mediated join). The list above is a convenience snapshot of a *derived* result — if it disagrees with `module-scope-map.js`, the file wins; re-run the one-liner.
- **No covering key? → file a module-map prep task FIRST.** Every `scope_modules` entry must be a real key from `moduleKeys()`. If a goal's planned work touches file paths that **no existing key covers** (e.g. a brand-new module dir, or code still fused under `src/bongos/` that isn't yet broken out as its own key), the scope wall cannot place that work. Do **not** invent a key. Instead, **add a prep task to this version** — `kind='refactor'`, scoped to `kernel` (the module that owns `module-scope-map.js`) — to extend `MODULE_GLOBS` so a key covers those paths, and make the dependent goal's tasks depend on it. Adding/editing a key is itself a `kernel`-scoped (Archon-gated) change, so flag it for Archon sign-off in this session.
- **Join policy** — a normal-scope goal is **open-join** (any builder); a goal whose scope includes a **`protected`** module is **Archon-mediated** (a non-Archon can't self-join; an Archon admits Metic+ members). Creating a protected-scope goal is itself **Archon-only** — so flag those for Archon sign-off in this session.
- **Optional seed tasks / lead** — any obvious first tasks, and who leads.

Present the goals as a short table (title · scope_modules · join policy · the criteria under it). Confirm the grouping and the scope of each before Phase 3 — the brainstorm then runs **per goal → per criterion**, and each net-new task is scoped to one goal.

> **Rescope is "previous or new" at the goal tier too.** If this version succeeds a prior one, you already decided in Phase 1 which prior goals carry forward — those become this version's goals (linked via `succeeded_by_goal_id`); the rest are net-new here.

### Phase 3 — Brainstorm

For each criterion, list every task that could serve it. Be thorough — the user will narrow. Include:

- Existing tasks already queued for the version (you have them from Phase 1)
- Open ideas tagged for the version that should be pulled in
- Net-new tasks the criterion implies but nobody has filed yet

Don't tunnel-vision. Surface lateral options the user might not have thought of:

- Cross-cutting tasks (renames, audits, sweeps)
- **Needs-exploration tasks** for criteria where the design isn't obvious yet (these become `kind='spike'` in the DB, but use the phrase "needs exploration" in conversation — clearer than "spike" for the user)
- Smoke tests / "this proves the criterion is met" tasks
- End-of-version lockdown tasks (e.g., rank-gating skills that were available to all during the version)

**Proactively propose needs-exploration tasks** for any criterion where the implementation path isn't clear. Don't wait for the user to flag it. Frame them as "this one needs an architecture pass first — output an ADR + sub-task list before we build."

**For each criterion, explicitly propose a proof-task** — the single live demonstration that proves the criterion is met. Examples: "Builder #2 onboards in ≤2h" for an onboarding criterion, "five concurrent builders shipping without collisions on staging" for a parallel-safety criterion. Without a proof-task, the criterion may technically ship without anyone knowing it works.

**Encourage short task descriptions with cross-refs.** Each task's description should focus on done-when + touches; reference dependency tasks by their R## rather than restating context. Long standalone descriptions are content-debt at scale (80 tasks × 200 words = a lot of redundant context).

> **`touches[]` is an advisory hint, not a hard fence ([ADR 0049](../../../docs/adr/0049-split-parallel-safety-contract.md)).** Parallel-safety is a *split contract*: for interactive single-human work, `git merge` is the authoritative collision detector and the claim-time overlap signal only warns; only the autonomous `--parallel` runner treats footprint overlap as a hard gate. So don't agonize over predicting every file at planning time — a rough blast-radius is enough, and a wrong prediction is no longer ship-blocking. (Step 7/8 — task [#882](https://amazonprimea.com/builders#/task/882) — makes the per-task `touches` field optional and backfills it from the committed diff at ship.)

Present the brainstorm **grouped by criterion, with every task numbered** (R## prefix or local numbering). Tags: `[E]` existing, `[I]` idea to pull, `[N]` net-new. Note totals per criterion and flag scope-tension points.

Ask the user to **edit (e), remove (r), or add (a) tasks BY NUMBER** per criterion. Format the prompt to make this explicit: "Reply per criterion with e/r/a + the task number — e.g. 'C1: e R03, r R07, a [task description]'".

### Phase 4 — Rank + dependencies

Once the task list is approved, rank everything AND wire dependencies.

**The system has two ordering signals — use both:**

1. **`dependencies[]`** (hard) — task A depends on task B if A cannot start until B has shipped. The auto-promotion trigger and claim-time check enforce this: a backlog task with all deps shipped (and `kind != 'spike'`) auto-promotes to `ready`; a claim attempt is refused if any dep is unshipped. Deps are the *meaning* of execution order.
2. **`V##.R##` rank prefix** (soft) — fine-grained ordering *within* the dependency-allowed set. Used as the tiebreaker for queue display. Topologically renumber so that for any A → deps → B, B's R## < A's R##.

**Spike tasks live in backlog by default.** The auto-promotion trigger skips `kind='spike'` — humans open spikes manually because spikes produce new tasks downstream and need a power-user decision before claim. Non-spike tasks auto-flow.

**Sanity-check schema constraints before designing the encoding.** This runs
against the Postgres on the Linux droplet over SSH — it's an Archon ops step, not
a builder-local one (so the bash/`ssh`/`psql` here is server-side by design, not
a Windows concern):

```bash
ssh lars@104.236.254.243 "psql -d amazonprimea -c '\\d tasks' | grep -i check"
```

Confirm what the `priority` column actually allows.

**Encoding (V3 convention):** priority is `1-5` (CHECK constraint). Use priority by tier:

- T1 (must ship first) = P5
- T2 (immediate follow-on) = P5
- T3 / T4 (parallel infra) = P4
- T5 (advanced features) = P3
- T6 (polish) = P2
- T7 (end-of-version lockdown) = P1

The fine-grained N-deep rank lives in the title prefix: `V<ver>.R##` zero-padded so alphabetical sort returns ranking order within a priority bucket.

Initial ranking: produce it yourself based on dependencies and what the user has stated as priority (e.g., "onboard builder #2 early"). Present in tiers. Ask the user to reorder, defer, or pull forward.

**Critical-path sequencing notes** to surface: which tasks gate which (architecture spikes gate the rest of their criterion; rename should be first; smoke tests should be last in their tier).

**Capture dependencies during the brainstorm, not after.** For each new task, ask yourself "which already-listed tasks must ship before this one is even claimable?" and write the answer next to the task. By the end of Phase 3 every task should have a `dependencies: [Rxx, Ryy]` field (possibly empty). Then in Phase 4:

1. Build the dep graph from the captured edges.
2. Run cycle detection — if a cycle exists, surface it and ask the user to break it (usually one side of the cycle is a "pair-with" relationship, not a true dep).
3. Topologically sort. Tiebreaker: lower current R## first (preserves planning intent), then alphabetical ref.
4. Re-number `V<ver>.R##` in topo order. The output is your final rank.

This is what the V3.R02 (task 309) dependency system encodes; Phase 5 writes both the title prefix and the `task_dependencies` rows.

### Phase 5 — Land it

Once ranking is agreed, do the writes in this exact order:

1. **Create a meta planning-session task** (`source_ref='<ver>-planning-N'`) that backs all the writes — version='<ver>', kind='decision', status='ready', priority=5, the full session described in its body. Claim it.

2. **Create the version's goals, then write the criteria migration.** Goals come first (ADR 0086) so the criteria can be parented under them:
   - **Goals** (via API — `POST /goals`; Archon-only when the scope includes a `protected` module). One per goal from Phase 2.5; **capture each returned goal id**.
     ```
     bongos exec scripts/gds/api.js POST /api/gds/goals --body '{"version_id":"<ver>","title":"...","scope_modules":["<key>", ...]}'
     # carry-forward goal: add "succeeds_goal_id":<prior_goal_id>
     ```
   - **Criteria — the vector depends on whether the instance is LIVE ([ADR 0105](../../../docs/adr/0105-instance-seed-migrations-out-of-core.md)):**
     - **On a RUNNING instance (the normal case — planning a new goal/version on prod):** create each criterion via the **`POST /api/gds/versions/:id/done-when`** API (Archon), passing `criterion_id` (a stable slug), `criterion_md`, `goal_id` (the goal from above), and optional `sort_order`. This is the ONLY vector that actually lands a NEW criterion on a live DB — a `done_when_criteria` INSERT in a CORE migration **fails the `selfhost-boot` gate** (scope-truth pollution), and one in `migrations/instance/` **silently no-ops on a normal deploy** (ADR 0105 applies instance seeds only under the owner opt-in `GDS_APPLY_INSTANCE_SEEDS=1`, a DR step). A duplicate `criterion_id` returns 409 — treat as "already seeded."
       ```
       bongos exec scripts/gds/api.js POST /api/gds/versions/<ver>/done-when --body '{"criterion_id":"<slug>","criterion_md":"...","goal_id":<gid>}'
       ```
     - **For a brand-new version scaffolded from scratch (DR / a fresh instance):** put the `INSERT INTO done_when_criteria` (with `goal_id`, `ON CONFLICT ... DO UPDATE`) in **`migrations/instance/<NN>_<ver_slug>_planning_seed.sql`** — and recreate the goal idempotently in the same file (the goal is a runtime row a replay won't have). Applies only under `GDS_APPLY_INSTANCE_SEEDS=1`.
   - **Migration** at `migrations/<NN>_<ver_slug>_planning_seed.sql` (CORE — platform-universal, non-scope-truth changes only): `UPDATE versions SET done_when = ...` and `UPDATE tasks` for existing-task priority + V##.R## title prefix (guarded by `WHERE title NOT LIKE 'V<ver>.R%'`). **Do NOT put versions/goals/`done_when_criteria` INSERTs here** — that's scope-truth and fails the `selfhost-boot` gate (ADR 0105).

3. **Write a seed script** at `scripts/gds/seed-<ver_slug>-tasks.js` modeled on `scripts/gds/seed-v3-tasks.js` containing:
   - The TASKS array — one entry per net-new task with full description, kind, discipline, priority, est_minutes, manual_degree, credits_reward, **optional** `touches` (see below), optional `promoted_idea_id`, `depends_on_refs: ['R##', ...]` (the dep edges captured during brainstorm), AND **`criterion_ids: ['Cn', ...]`** — the done-when criterion(s) this task gates. The brainstorm in Phase 3 is already grouped by criterion, so this is just transcribing that grouping. Use the positional `"Cn"` token (C1 = the version's first criterion); the server resolves it against the task's version at create (ADR 0025 / task 438). **This replaces the old `**Criterion:** Cn` prose** — don't write that line anymore; pass `criterion_ids` instead so the task is linked in `task_criteria` at creation and `/status` counts it with no backfill.
   - **`touches` is now OPTIONAL (task 882 / [ADR 0049](../../../docs/adr/0049-split-parallel-safety-contract.md)).** Omit it (or leave it blank) unless you already know a tight file set and want the advisory overlap signal during the brainstorm. At first `/builder-ship` the server backfills `touches[]` from the real committed diff — the declared set becomes what git actually reported. Don't burn planning effort predicting file lists; a rough or absent prediction is fine and no longer ship-blocking.
   - **`requires_rank` AUTO-DERIVES — you don't hand-set it per task (task [#1498](https://amazonprimea.com/builders#/task/1498) / [ADR 0084](../../../docs/adr/0084-auto-derived-per-task-rank-floor.md)).** On create the server floors a task at `metic` when it is `security_sensitive` or its `touches` reach the permission / authz / ship-grade / deploy / migration core (the same protected paths a sub-Metic builder can't push to); everything else stays the open `xenos` default. To deliberately gate a task **higher** than the auto-floor (e.g. owner-only work), pass `requires_rank: 'metic' | 'archon'` on the task — it can only RAISE the floor, never drop below it.
   - **Pass `goal_id: <gid>` on each task** so it lands under its goal (not the version's default catch-all). `POST /tasks` now honors `goal_id` (validated to belong to the version); to move an already-created task, `PATCH /tasks/:id` with `{goal_id}` (task 1763). `criterion_ids` accepts a **slug** (the `criterion_id` you set above), a `"Cn"` position, or a numeric id — the slug is position-independent and cleanest.
   - A main() that POSTs each task **with its `criterion_ids`** (idempotent on `source_ref`; the criterion links are inserted at create, idempotent on `(task_id, criterion_id)`), PATCHes `idea_inbox` for promotions, and after all tasks exist, POSTs `task_dependencies` via `POST /tasks/:id/dependencies` (resolving each R## to the just-created task ID). Idempotent on `(task_id, depends_on_task_id)`. (Need to re-attribute an already-seeded task? `POST /tasks/:id/criteria` with `{criterion_ids:['Cn',...]}`; `DELETE /tasks/:id/criteria/:criterionId` to detach — both Metic+ ([ADR 0090](../../../docs/adr/0090-metic-task-authoring.md)), mirroring the dependency endpoints.)

4. **Apply the migration** (commit + push + deploy, or direct psql via SSH for hot-fix style).

5. **Run the seed script.** Verify exit code 0; verify totals via `GET /api/gds/public/progress` and `GET /api/gds/versions/<ver>/done-when`.

6. **Promote the zero-dep layer to `ready`.** Every newly-seeded task lands `status='backlog'`. The auto-promotion trigger only fires when a *dependency* ships — so a task with zero deps has nothing to wait for and would sit unclaimable forever. Run, in the same psql session as the migration (or via SSH to the droplet):

   ```sql
   UPDATE tasks
   SET status = 'ready', promoted_at = now()
   WHERE version_id = '<ver>'
     AND status = 'backlog'
     AND kind <> 'spike'
     AND id NOT IN (SELECT task_id FROM task_dependencies)
   RETURNING id, title, priority, kind;
   ```

   Capture the `RETURNING` rows — the max `priority` value is the input for step 7. Spikes are intentionally excluded; they never auto-promote (kind='spike' convention, [ADR 0015](../../../docs/adr/0015-task-dependencies-and-auto-promotion.md)).

7. **Surface higher-priority spikes still in backlog.** Spikes don't auto-flow because their output reshapes downstream work — that's a feature, not a bug. But the planning session just decided the priority order, so a high-priority spike sitting unstarted while lower-priority non-spike work flows to `ready` is a coordination smell worth one explicit mention. Query:

   ```sql
   SELECT id, title, priority
   FROM tasks
   WHERE version_id = '<ver>'
     AND status = 'backlog'
     AND kind = 'spike'
     AND priority >= <max_priority_from_step_6>
   ORDER BY priority DESC, title;
   ```

   The bar is **relative** — `>= max(priority of the rows promoted in step 6)`. If lower-priority non-spike work was promoted, only equal-or-higher-priority spikes surface; lower-priority spikes are noise at planning-land time and stay silent.

   If the query returns rows, surface them to the user verbatim:

   > "Heads up — these spikes sit at priority ≥ the top of your ready queue. They don't auto-promote (kind='spike', [ADR 0015](../../../docs/adr/0015-task-dependencies-and-auto-promotion.md)). If any gates downstream work, open it manually: `POST /api/gds/tasks/<id>/promote`"

   If the query returns nothing, stay silent. Don't volunteer info about lower-priority spikes — the next planning session or `/idea-triage` walk will handle those at the right moment.

8. **Commit + push** the migration + seed script + any new skill files + the session-log entry.

9. **Ship the meta task** via `/builder-ship` with a clean value-summary.

## How to use — quick reference

All API calls go through the cross-platform `bongos exec scripts/gds/api.js` helper —
it signs each request with your session token (no manual token extraction) and
runs on Windows/macOS/Linux.

```
# Phase 1 — pull state
bongos exec scripts/gds/api.js GET /api/gds/public/versions
bongos exec scripts/gds/api.js GET "/api/gds/tasks?version=<id>"
bongos exec scripts/gds/api.js GET /api/gds/inbox
bongos exec scripts/gds/api.js GET /api/gds/versions/<id>/done-when
```

Phase 5 writes use the same `POST /tasks`, `PATCH /inbox/:id` shape as `idea-triage` and `seed-v3-tasks.js`. Mirror those patterns rather than inventing new ones.

## Tone for the user

Lars is the prompter (see CLAUDE.md §2). Frame criteria and tasks in terms of outcomes and player/builder experience, not implementation. When asking him questions, ask about *what changes when this is true*, not *how would we build it*. Decide implementation details yourself and present them for confirmation.

When the user pushes back ("criteria 4/5/6 are weak"), take it seriously and rewrite. Strong outcome criteria are the hard part — the rest of the session is downstream of them.

When the user says "I am ready to rank" or "produce the initial ranking," do it in one shot. Don't bounce back with more clarification questions unless something genuinely ambiguous needs resolving.

## After the session — improvements pass

At the end of every planning session, ask the user the retrospective question:

> "Anything we should do differently in the next planning session? My own observations from this one:"

Then offer 2-4 concrete recommendations based on how the session actually went (e.g. weak criteria caught late, ranking done by chat vs artifact, a schema constraint hit at first write). File them as `idea_inbox` rows tagged `kind='skill-friction'` so the skill improves over time.
