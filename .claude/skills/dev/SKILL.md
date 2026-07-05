---
name: dev
description: The engineering session — the operating playbook for engineer-discipline work (code, infra, the GDS itself, bugs, performance). Triggers when the user says "/dev", "let's build this", "work on this bug/feature", "start a dev session", or when a claimed task's discipline routes here (claim.js prints a directive to invoke /dev for engineer tasks). This is the project's DEFAULT build loop, written down — the baseline the other discipline modes (/ideate, /paint) invert from.
---

You are running an **engineering session** for Off the Boats. Unlike `/ideate` (which flips *who drives*) and `/paint` (which flips *the medium*), this skill introduces no new dynamic — engineering **is** the default text-and-code loop. Its job is to make the standard explicit and keep you on it. Read it before working; lean on it most when you're new here or running autonomously.

## The loop: understand → scoped change → verify → ship

1. **You hold a claim — keep the work inside it.** Everything you change should serve the claimed task. An out-of-scope fix you spot along the way is a *separate* task or an idea (`bongos exec scripts/gds/capture.js`), not a quiet addition to this diff. Scope creep is the most common way an engineering session goes wrong.

2. **Understand before you edit.** Read the code you're about to change and the layer around it first:
   - The nested `CLAUDE.md` in the directory you're working in (loads on demand — it has the gotchas).
   - `docs/repo-map.md` (the symbol skeleton) to navigate without reading every file — it's gitignored + regenerated at deploy/box-fetch (ADR 0110), so if it's absent in your tree run `bongos exec scripts/gds/gen-repo-map.js`. And `/recall <topic>` to find what's already known/decided so you don't re-solve it.
   - Match the surrounding code: its naming, its idioms, its comment density. Code you write should read like the code already there.

3. **Make the smallest correct change.** Prefer the change that solves the task and nothing more. Don't refactor adjacent code "while you're here" unless the task is the refactor.

4. **Verify it — never report done on faith.** This is the step engineers most often skip:
   - Run the smoke tests (`/builder-ship` runs them, but run them yourself while iterating).
   - If the change is observable in the running app, use the **preview / verification workflow** (preview_start → reload → check console/snapshot → screenshot proof) rather than asking a human to check manually. Verify, then share the proof.
   - If it's not browser-observable (a different runtime, types, tooling), say so and verify the way that *does* exercise it.

5. **Ship with a real handoff.** `/builder-ship` chains completed → confirmed (credits, smoke) → shipped (grade, merge, deploy). Give it genuine `--notes` (what changed + how you verified) and a non-jargon `--summary` (the business-owner audience reads it in Discord #ship-news). If the grader flags findings, fix them and re-grade — don't reach for an override.

## Supporting discipline (the things that keep the ledger honest)

- **Every change is backed by the claimed task** — no admin/tiny-fix/scaffolding loophole (CLAUDE.md §8). Direct DB writes are work too.
- **Non-obvious decision → an ADR** in `docs/adr/`, linked from the shipping task's notes.
- **A discovery that took >10 min to diagnose → a learning** (`bongos exec scripts/gds/learning-capture.js`); a multi-page how-to → a recipe under `docs/recipes/`.
- **Blocked on something only Lars can decide/provide → a blocker** (`POST /api/gds/blockers`), attached to the task.
- **Touched anything the onboarding diagrams / repo-map describe** → they regenerate on deploy; never hand-edit generated artifacts — edit the source/template and run the generator (`gen-diagrams.js`, `gen-repo-map.js`).
- **Trust boundary:** a sub-Metic builder (Xenos/Thetes) stays out of the permission/pipeline core (rank/authz machinery, the ship/grade/deploy pipeline, `migrations/`, `infra/`, trust-boundary docs) and never runs raw `git push origin main` / `ssh` / `~/deploy.sh` — landing code is the GDS's job (`/builder-ship`). Metic+ is unaffected.

## Step 0 — detect the mode

**Is a human present?**

- **Interactive** (someone is here to decide): work collaboratively — propose the approach for anything non-obvious, let the human steer the design calls, then execute. You can think out loud; engineers are fine with text.
- **Autonomous / bypass-permissions** (no human will answer): tighten up.
  - Be **conservative** — the smallest correct change, the lowest-risk path. No human is here to catch a wandering edit.
  - **Verify harder**, not less — smoke + preview proof before you call it done, because nobody else will look first.
  - **Don't invent scope or wander** into adjacent work, refactors, or "improvements" the task didn't ask for. If you spot them, capture them as ideas/tasks and move on.
  - If the task is **ambiguous or you hit a real blocker**, leave a clear note (blocker / release with a reason) rather than guessing at something large and irreversible.

## How sessions reach this skill

- **Standalone:** invoke `/dev` directly when you want the engineering checklist in front of you.
- **From a claim:** when a builder claims an `engineer`-discipline task, `claim.js` reads `scripts/gds/discipline-modes.json` and notes that `/dev` is this task's playbook. Engineering is already the default loop, so this is a *reminder of the standard* (and the autonomous-mode guardrails), not a redirect away from how you'd otherwise work. All three disciplines route uniformly through the same map.
