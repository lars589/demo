---
name: otb-character-review
description: Review a painterly character ANIMATION (a character_anim family — many frames of one character in different poses) against the ADR 0088 animation criteria. Triggers when the user says "review this animation", "score the bongo idle", "check the character animation", "is this animation consistent", "rate these frames", or asks how a generated character/mascot animation holds up. Sibling to otb-design-review (which scores a single pixel-art tile). Returns a plain-language verdict per frame and for the sequence: same character throughout, correct anatomy, each frame on its intended pose, clean edges, and smooth in-order motion. Wraps family_orchestrator.run_family + family_review for the painterly path.
---

You are reviewing a painterly **character animation** — a `character_anim` family: many frames of the *same* character in *different* poses (e.g. the Bongo Buddha idle-breathing cycle). This is the animation sibling of `otb-design-review` (which scores one pixel-art tile). Do NOT judge it as pixel art — there is no palette to match, no FireRed reference, no 32×32 grid.

## What this skill does

It runs the existing family pipeline (ADR 0088) on a painterly character family and translates the result into a plain-language verdict. Two layers, same as the tile pipeline:

- **Deterministic checks** (`modules/art-pipeline/pipeline/family_checks.py`, free, no API) — the primary gate:
  - `silhouette_area` / `silhouette_height` — the character is the same size in every frame.
  - `dominant_overlap` / `luminance_emd` — same colours and lighting across frames.
  - `edge_halo` — no glow ring / aura / magenta fringe on any frame.
  - `perceptual_identity` — no frame is a grossly different individual (dHash-to-anchor backstop).
  - `transition_no_jump` / `transition_no_dead` — read in order, the motion neither teleports nor stalls on a duplicate frame.
- **AI vision review** (`modules/art-pipeline/pipeline/family_review.py`, Gemini 2.5 Flash) — the subjective criteria:
  - `family_consistency` — all frames read as one set.
  - `character_identity` — every frame is the SAME individual.
  - `anatomy_correct` — exactly two hands/feet, no extra/fused/melted limbs, no warped faces.
  - `pose_match` — each frame hits its intended pose AND the frames form a smooth motion arc in order.

## How to use

1. **Review existing frames** (the common case — frames already sliced into a dir):
   ```
   python3 modules/art-pipeline/pipeline/family_review.py <family_id> <frames_dir> <raw_sheet.png>
   ```
   This prints the deterministic report + the Gemini review JSON. For a fast,
   free deterministic-only pass (no Gemini call), use:
   ```
   python3 modules/art-pipeline/pipeline/family_checks.py <family_id> <frames_dir>
   ```

2. **Generate + grade from scratch** (the full generate→grade→audit→regenerate loop):
   ```
   python3 modules/art-pipeline/pipeline/family_orchestrator.py <family_id> [--max-attempts N] [--publish]
   ```
   The orchestrator calls the same checks + review internally and retries with the
   fix-hints. Frames live under `modules/art-pipeline/iterations/_families/<family_id>/`.

3. **Fill to a full frame count + package** (after the keyframes pass): the
   recursive inbetween layer (`modules/art-pipeline/pipeline/inbetween.py`) generates the in-between
   poses and `modules/art-pipeline/pipeline/sequence_assembly.py` writes the sprite set + strip +
   `manifest.json`. (The one-call module entry point is the `character_anim`
   Cloud Bongos module.)

## Interpret the verdict

The review returns `verdict` + per-criterion scores + a `fix_hint`:
- **`pass`** (total ≥ the family's `pass_threshold`, no criterion under its hard-fail min) → accept; proceed to inbetweening / assembly.
- **`retry`** (some scores below threshold but salvageable) → regenerate with the `fix_hint`.
- **`escalate_tier`** (deeply wrong) → the current approach isn't working; escalate (different tier / the deferred LoRA "level 2").

A failing **deterministic** check blocks the Gemini review entirely (it saves the credit) — fix the mechanical issue first; its `fix_hints` are specific and numeric.

## Surface to the user in plain language

Don't dump raw JSON. Translate, **per frame and for the sequence**:
- Which frames (by id) are the problem and why — e.g. "frame `idle_f3` has a faint glow ring", "`idle_f2→idle_f3` barely moves (a dead frame)", "frame 4 drifted to a different robe colour".
- The overall verdict + the single most important next change (the `fix_hint`).
- Whether the motion reads as smooth and on-model, or where it breaks.

## Cost

Deterministic checks: free. One Gemini family review: ~negligible (a few thousand tokens). Generation (if you run the orchestrator): ~$0.04/frame on Gemini image, so a full action is well under $1 even with retries. Always run the free deterministic pass first.

## When to use this directly vs. via orchestrator

Use this skill **directly** to score frames Lars already has (a finished action, a spot-check, an asset dropped in). Use the **orchestrator** (which calls the same review internally) when generating an action from scratch.
