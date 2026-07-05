---
name: otb-tile-generate
description: Generate one or more pixel-art tiles for the Amazonprimea world. Triggers when user says "generate a tile", "make a sprite for X", "regenerate Y", or asks for new world art. Reads the design template, runs the full generate→post-process→review→retry orchestrator, saves results into modules/art-pipeline/generated/tiles/, logs cost. Always reuses the locked palette and rubric in modules/art-pipeline/template/.
---

You are operating the Amazonprimea pixel-art generation pipeline. The user has asked you to produce one or more tiles. Do NOT freelance — use the existing pipeline.

## What this skill does

Runs `modules/art-pipeline/pipeline/orchestrator.py` for the requested tiles. The orchestrator does generate → post-process to 32×32 → score against rubric → retry/escalate up to 5 tiers → save final PNG. All cost is logged to `modules/art-pipeline/iterations/cost_ledger.jsonl`.

## How to use

1. **Identify the tile(s)** the user wants. They may name an existing vocab id (`grass_base`, `sea_shallow`, etc.) or describe something new.

2. **If new**, append the new entry to `modules/art-pipeline/template/vocabulary.json` with id, kind (`tile` | `edge` | `sprite`), priority (A/B/C), description, and ref_clusters (best-fit cluster ids from `modules/art-pipeline/template/cluster_overview.png`). Then proceed.

3. **Check the budget** before running:
   ```
   python3 modules/art-pipeline/pipeline/cost_ledger.py status
   ```

4. **Run the orchestrator** for the tile(s). Either by priority letter:
   ```
   python3 modules/art-pipeline/pipeline/orchestrator.py A
   ```
   or write a one-line wrapper that calls `run_tile(item)` for the specific id. The orchestrator exits with a summary.

5. **Inspect the result** at `modules/art-pipeline/generated/tiles/<id>.png` (final accepted) or `modules/art-pipeline/iterations/<id>/log.jsonl` (full attempt history). If the tile passed, the corresponding entry in `modules/art-pipeline/iterations/run_summary.json` will show `status: "pass"`. If best-effort, scoreboard the gap and decide whether to retry.

   **View it on your sandbox without placing it in-game** (#1262): every tile you've generated — native + zoomed, with its score and critique — is served at **`https://sandbox-<login>.amazonprimea.com/art`** (locally: `http://localhost:<port>/art`). This is the generated-art *gallery* (`modules/art-pipeline/generated/preview.html`), so you can show the builder what they made even when the tile isn't placed in the world yet. The atlas-rebuild in-game step below is only needed once you actually want it *in the playable world*.

6. **See it in-game on your sandbox** (#1067): run `bongos exec scripts/gds/art-stage.js` — it rebuilds the atlas the client loads, surfaces it on your sandbox live preview (`sandbox-<login>.amazonprimea.com`, ADR 0044), and prints the URL + affected tiles. With the auto-reload (task 1065) an already-open tab refreshes itself. (The family/refresh runs also accept `--stage` to do this automatically: `family_orchestrator.py <id> --publish --stage`, `refresh_all.py --stage`.) Only a genuinely NEW base-tile *type* still needs a `public/game/world/tilePalette.js` mapping edit; an updated existing tile just needs the atlas rebuild above.

## Constraints

- Never bypass the review step. If a tile passes deterministic checks but fails AI review, regenerate with the fix_hint — do not paper over.
- Never modify the locked palette (`modules/art-pipeline/template/palette.json`) without an ADR. Theme drift = palette drift = whole-world drift.
- Hard stop at $80 in the cost ledger. If approaching, stop generating, surface remaining budget to the user.

## Files this skill touches

- READS: `modules/art-pipeline/template/{vocabulary.json,style_guide.md,rubric.json,palette.json,cluster_overview.png,ref_clusters/*}`
- WRITES: `modules/art-pipeline/iterations/<tile_id>/`, `modules/art-pipeline/generated/tiles/<tile_id>.png`, `modules/art-pipeline/iterations/cost_ledger.jsonl`
- Optionally edits: `modules/art-pipeline/template/vocabulary.json` (add new entries), `public/game/world/tilePalette.js` (wire up)
