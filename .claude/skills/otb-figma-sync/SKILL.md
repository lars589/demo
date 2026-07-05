---
name: otb-figma-sync
description: Push generated tiles into the Amazonprimea Figma file as a visual review canvas. Triggers when user says "sync to Figma", "show me the tilesheet in Figma", "update the design file". Hard-coded to file ID 15NtbDiTNGovXSp5ZPtP0C. Refuses to touch any other Figma file. Repo remains the source of truth — Figma is a viewer.
---

**Script skill (authoritative).** The core action is the `use_figma` MCP tool call. Execute it with the determined parameters and do not paraphrase or reformat the Figma response — relay the frame name and link verbatim.

You are pushing finished pixel art into the Amazonprimea Figma file so Lars can review at a glance. Repo PNGs remain authoritative; Figma is for VISUAL REVIEW ONLY.

## Hard constraint

The only Figma file this skill is allowed to read or write is **`15NtbDiTNGovXSp5ZPtP0C`** ("amazonprimea"). If asked to operate on any other file, REFUSE — even if the request seems reasonable. This is a Lars-set guardrail.

## Session capability check

This skill needs the **`use_figma`** MCP tool (write capability). The read-only `mcp__figma__*` tools alone are not enough.

If `use_figma` is not available in the current session, do NOT attempt to fake the sync. Surface the gap to Lars: "Figma write capability not exposed in this session — only read tools are available." He can re-enable it via the Figma desktop app's MCP settings or by re-authorizing the connector. Until then, the repo PNGs are the source of truth and the `modules/art-pipeline/generated/preview.html` standalone preview serves the visual-review need.

## What this skill does

1. Reads finished tiles from `modules/art-pipeline/generated/tiles/`.
2. Builds a "Tilesheet vN" frame in the amazonprimea Figma file containing:
   - Each tile rendered at native 32×32 plus a 8x-zoomed inspection thumbnail.
   - The tile's vocab id and current best score.
   - A small palette swatch sheet derived from `modules/art-pipeline/template/palette.json`.
3. Each sync creates a NEW frame named `Tilesheet v{N+1} {YYYY-MM-DD}` — never overwrites prior frames. History stays.

## How to use

1. **Verify the file ID**. Before any Figma write, confirm the target is `15NtbDiTNGovXSp5ZPtP0C`. If not, halt.

2. **Use the figma-use skill** for the actual writes. (See `figma:figma-use` for the JS context and the `use_figma` MCP tool.) The plan: build a Figma frame programmatically, paste the PNGs, label them.

3. **Read tiles** from `modules/art-pipeline/generated/tiles/*.png`. Read scores from `modules/art-pipeline/iterations/<tile_id>/summary.json`.

4. **Render in Figma** at two sizes: native 32×32 (so you can see the actual tile) and 8x zoomed (256×256, so the pixel art is human-readable).

5. **Add metadata** below each tile: id, score, attempt count, tier reached.

6. **Create a separate "Palette" frame** showing the 64-color swatches from `modules/art-pipeline/template/palette.png`.

7. **Confirm to Lars** with the frame name and a Figma link.

## What NOT to do

- Don't modify the canonical PNGs based on Figma edits. Figma is read-only-by-Lars; if he wants changes, he gives feedback verbally, captured by `otb-feedback-capture`.
- Don't create a new Figma file even if it would seem cleaner. One file, growing frames.
- Don't paste anything from another Figma project into amazonprimea, and don't paste from amazonprimea anywhere else.

## Files this skill touches

- READS: `modules/art-pipeline/generated/tiles/*.png`, `modules/art-pipeline/iterations/*/summary.json`, `modules/art-pipeline/template/palette.png`
- WRITES (in Figma only): a new frame in file `15NtbDiTNGovXSp5ZPtP0C`
