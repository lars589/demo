---
name: otb-feedback-capture
description: Convert verbal design feedback into a durable rule appended to the Amazonprimea style guide. Triggers when Lars gives directional notes ("trees too modern", "saturation too high", "containers should look weathered"). Updates modules/art-pipeline/template/style_guide.md with a dated rule so future generations automatically respect it. This is how the system gets better over time.
---

You are turning a one-time piece of feedback into a permanent guardrail. The whole point of this skill is that **Lars should not have to repeat himself**. If he tells you trees should be more gnarled, every future tree generation should bake that in.

## What this skill does

1. Reads the verbal feedback from the conversation.
2. Distills it to one rule: short, actionable, scoped to the right tile category.
3. Appends it to **§ Visual rules** in `modules/art-pipeline/template/style_guide.md` with today's date.
4. **Optionally** updates the rubric (`modules/art-pipeline/template/rubric.json`) if the feedback warrants a new criterion or stricter threshold — this is rarer; ask if unsure.
5. **Optionally** updates the prompt rules (per-tile descriptions in `modules/art-pipeline/template/vocabulary.json`) if the feedback is tile-specific.

## How to use

1. **Distill** the feedback. Examples:
   - "trees too modern, more gnarled" → *Olive trees: gnarled trunk implication should always be visible at canopy base; canopy is silver-green not bright green.*
   - "container looks too new" → *Container exterior: must always include rust streaks and faded paint patches; never pristine metal.*
   - "saturation too high overall" → *Global: saturation cap at ~70% — anything more reads cartoonish, breaks "secret discovery" brand feel.*

2. **Pick the scope**:
   - **Global** → append to § Visual rules in `style_guide.md`.
   - **Tile-specific** → also update the `desc` field for that tile in `vocabulary.json`.
   - **Rubric-changing** → propose a new criterion or threshold change; do not silently edit the rubric.

3. **Append with a date stamp**, never overwrite or delete. Format:
   ```
   - **[YYYY-MM-DD]** <one-sentence rule>. (Source: Lars feedback on <tile_id> attempt <N>.)
   ```

4. **Confirm to Lars** what rule you saved, in one line. He should know what's now baked in.

5. **Update the relevant memory** at the end of the session. The style guide IS the memory — but if the feedback is meta-level (e.g. about the workflow, not the art), capture it as a feedback memory in `~/.claude/projects/.../memory/`.

## What NOT to do

- Don't delete or overwrite prior rules. The guide grows; conflicts get resolved by adding a stricter rule on top, not erasing the older one.
- Don't auto-broaden tile-specific feedback into a global rule. If Lars says "this *one* sand tile looks wrong," only update sand_base — not the global guide.
- Don't capture aesthetic preferences as hard rubric criteria unless Lars explicitly asks for them in the rubric.

## Files this skill touches

- WRITES: `modules/art-pipeline/template/style_guide.md` (always), `modules/art-pipeline/template/vocabulary.json` (sometimes), `modules/art-pipeline/template/rubric.json` (rarely)
