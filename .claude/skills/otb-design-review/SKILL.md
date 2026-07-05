---
name: otb-design-review
description: Score an existing pixel-art tile against the Amazonprimea rubric. Triggers when user says "review this tile", "score X", "rate Y", or asks how a generated asset stacks up. Returns per-criterion scores, a critique, a verdict (pass/retry/escalate_tier), and a fix_hint. Uses Gemini 2.5 Flash vision plus deterministic palette/grid checks.
---

You are scoring a generated tile against the Amazonprimea quality rubric. Do NOT critique freelance — use the rubric in `modules/art-pipeline/template/rubric.json`.

## What this skill does

Wraps `modules/art-pipeline/pipeline/review.review()`. It runs:
- **Deterministic checks**: dimensions, palette compliance, color count, mode.
- **AI vision review** (Gemini 2.5 Flash): the 9 rubric criteria with per-criterion 0-10 scores and short critiques.

Returns structured JSON with scores, verdict, and a fix_hint for the next attempt.

## How to use

1. Identify the tile PNG path and its vocab id.

2. Run:
   ```
   python3 modules/art-pipeline/pipeline/review.py path/to/tile.png <vocab_id>
   ```
   This prints the JSON result.

3. **Interpret the verdict**:
   - `pass` (total ≥ 9.0, no hard fails) → accept, wire into game.
   - `retry` (some scores below threshold but salvageable) → regenerate with the fix_hint.
   - `escalate_tier` (deeply wrong) → next tier in orchestrator (image-to-image, model swap, procedural fallback).

4. **Surface to the user** in plain language: which criteria scored low, the verdict, and the recommended next step. Don't dump raw JSON — translate.

5. **Cost**: ~$0.0001 per review (Gemini 2.5 Flash, ~1k tokens). Negligible vs. generation.

## What "good" looks like

The rubric is in `modules/art-pipeline/template/rubric.json`. Pass requires total ≥ 9.0 AND no individual criterion below its hard-fail threshold. The hard-fail thresholds are tighter on objective criteria (grid, no_aa, palette: <7) than subjective ones (firered_match, mythic_greek, brand_feel: <5).

## When to use this directly vs. via orchestrator

Use this skill **directly** when:
- Reviewing a one-off asset Lars dropped in.
- Scoring a final tile before wiring it into the game.
- Spot-checking iteration outputs after a run.

Use the **orchestrator** (which calls this internally) when:
- Generating a new tile from scratch (it loops generate→review).
