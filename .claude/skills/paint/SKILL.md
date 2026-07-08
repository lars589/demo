---
name: paint
description: The art session — the operating playbook for artist-discipline work. Triggers when the user says "/paint", "let's make art", "I want to work on a tile/sprite", "start an art session", or when a claimed task's discipline routes here (claim.js prints a directive to invoke /paint for artist tasks). Show-first, low-text: Claude communicates in pictures, not prose, and drives the existing pixel-art pipeline underneath.
---

You are running an **art session** for Off the Boats. This is not the engineer's text-heavy build loop. Read this whole file before acting — it changes how you *communicate* for the rest of the session.

## The one rule that makes this different: communicate in pictures, not prose

In every other discipline, Claude narrates — diffs, logs, paragraphs of what it's doing. **Here that is the failure mode.** An artist judges with their eyes, not by reading a wall of text about post-process tiers. So:

> **Show, then briefly caption. Never narrate the pipeline at length.** Every step ends in an *image* the artist can look at, with at most a one-line caption. The text-heavy plumbing still runs — it just runs quietly.

Concretely:

- **End every step with something visual.** After a generation: display the PNG (Read the file so it renders, or screenshot the gallery / in-world sandbox). After a rubric check: show the scorecard, not a prose summary. The artist should *see* the result before they read a single word.
- **Collapse the plumbing to one-liners.** Budget checks, `vocabulary.json` edits, orchestrator retry tiers, atlas rebuilds — do them, but report them as a single line or a number, not a play-by-play. "Generated, rubric 0.91, on-palette, staged ✓" beats three paragraphs.
- **Verification = look, not read.** Surface the gallery and the in-world sandbox (URLs + a screenshot), not console logs. Logs are for when something *breaks*, not for routine success.
- **The artist owns the look; you own the rendering.** You drive the pipeline and handle the mechanics; they react to pictures and steer. You are their hands, not their art director.

## Step 0 — detect the mode

**Is an artist present in this session?**

- Normal interactive session (someone is here to look and react) → **Interactive mode**.
- Autonomous / bypass-permissions / scheduled run (no one is watching the images) → **Autonomous mode**.

If unsure, ask once; if no answer, treat it as autonomous.

## Step 1 (both modes) — load the look before you make anything

Ground every asset in the locked theme so nothing drifts:

- `modules/art-pipeline/template/style_guide.md`, `modules/art-pipeline/template/rubric.json`, `modules/art-pipeline/template/palette.json` — the look you must hit: 16-bit pixel art, early-Pokémon (FireRed) touchstone, top-down, 32×32, locked 64-colour Mediterranean palette (olive greens, warm tans, turquoise sea, weathered marble — never spring green, navy, or pine).
- `modules/art-pipeline/template/vocabulary.json` + `modules/art-pipeline/template/cluster_overview.png` — what exists and the reference clusters.
- **The palette and rubric are non-negotiable.** Never edit `palette.json` or `rubric.json` without an ADR — palette drift is whole-world drift.

## Interactive mode — show, react, iterate

1. **Establish the visual target first, not in prose.** Confirm the subject (an existing vocab id, or a new in-world prop/plant/animal/accessory) and, if helpful, show the reference cluster it should sit beside. One or two lines, then move to making.
2. **Generate via the pipeline — never freelance.** Drive `/otb-tile-generate` (which runs `modules/art-pipeline/pipeline/orchestrator.py`: generate → post-process to 32×32 → score against rubric → retry up to 5 tiers → save to `modules/art-pipeline/generated/tiles/<id>.png`, logging cost). Check the budget first (`python3 modules/art-pipeline/pipeline/cost_ledger.py status`; hard stop at $80) — but report it as one line.
3. **SHOW the result.** Display the final accepted PNG and its rubric score. The gallery serves every tile (native + zoomed, with score + critique) at `sandbox-<login>.demo.cloudbongos.com/art` — point them there and/or render the image inline. **Default visibility: show the final accepted asset and any failures. Show the intermediate retry attempts only if the artist asks ("show me the attempts").**
4. **See it in the world.** When they want it placed, run `bongos exec scripts/gds/art-stage.js` — it rebuilds the atlas and surfaces the asset live in the game on their sandbox (auto-reloads an open tab). Screenshot/point at the in-world view. (A genuinely new base-tile *type* also needs a `public/game/world/tilePalette.js` mapping edit; an updated existing tile just needs the rebuild.)
5. **Feedback is visual → a durable rule.** When the artist reacts ("too saturated", "trees too modern", "weather the marble"), don't just tweak once — run `/otb-feedback-capture` to write the note into `modules/art-pipeline/template/style_guide.md` as a dated rule, then regenerate and **show the new result**. The loop is see → react → see again, and the style guide gets smarter each pass.
6. **Use `/otb-design-review`** when you want a rubric-grounded second opinion on whether an asset truly hits the bar — surface its numbers, not a paragraph.

## Autonomous mode — make it, gate it, park the pictures

No one is watching the images, so do not narrate into the void and do not lower the bar.

1. **Generate via the pipeline** for the claimed asset(s), same orchestrator, budget-aware.
2. **Rubric-gate hard.** Ship/stage only assets that genuinely PASS the rubric (`modules/art-pipeline/iterations/run_summary.json` status `pass`). If a tile only best-effort'd, regenerate with the `fix_hint` — never paper over a fail, and never stage a best-effort-only asset.
3. **Stage to the gallery and PARK for human review.** Stage passing assets so they appear in the `/art` gallery and (if in-world placement is in scope) via `art-stage.js`, then leave them for a human to eyeball. In the session log / ship notes, give the gallery URL and a one-line-per-asset list (id + score) — so the first thing the returning artist does is *look*, not read.

## How art TASKS should be framed (target-and-rubric, not prose-and-procedure)

When you scope or present an art task, factor in the visual background:

- **Lead with the visual target**, not paragraphs — the subject, the reference cluster it belongs beside, an example image if one exists. "Make this," shown.
- **Express `done_when` in visual / rubric terms** — "passes the rubric, reads as weathered marble in-world, every pixel on the locked palette" — not procedural step lists.
- **Keep procedure out of the task; the skill carries the how.** The task says *what to make* and *what good looks like*; `/paint` knows the commands.

## How sessions reach this skill

- **Standalone:** the user invokes `/paint` directly (e.g. "let's make a tile") — no claimed task required to explore.
- **From a claim:** when a builder claims an `artist`-discipline task, `claim.js` reads `scripts/gds/discipline-modes.json` and prints a directive to invoke `/paint`. Both paths run this same file — the single home of the art-session experience. (The newcomer "generate one new in-world asset" chore is one valid *outcome* of an interactive session, not a separate flow.)

## Stay clear of (READ-ONLY)

Never modify the locked palette (`modules/art-pipeline/template/palette.json`) or rubric (`modules/art-pipeline/template/rubric.json`) without an ADR. Touch only art assets / `vocabulary.json` under `art/` (and, at most, the `public/game/world/tilePalette.js` wiring for a genuinely new base-tile type). Do not touch permission, pipeline-core, migration, or infra files.
