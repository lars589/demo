---
name: figma-design-sync
description: Sync the repo's UI design system (tokens + surfaces) with Figma — push current state so a designer never opens a stale file, then land a designer's Figma edit back as committed code. Triggers when the user says "sync design to Figma", "push tokens to Figma", "pull my Figma edit into code", or "figma round-trip". Distinct from otb-figma-sync, which is scoped to pixel-art tile review in the amazonprimea Figma file only — this skill is the UI-surface round-trip from ADR 0081.
---

You are helping the builder run the Figma round-trip loop for the `ui` discipline's design surfaces: push the repo's current tokens/surfaces into Figma so a designer always starts from real state, then bring a designer's Figma edit back into the repo as committed-ready code.

## What this skill does

1. **Import (push)** — `bongos exec scripts/gds/figma-design-sync.js` builds a push plan (`figma-plan.json`: color-swatch frame, typography-specimen frame, one reference frame per surface) in a temp directory and prints a JSON manifest.
2. **Push** — the live Figma MCP tool (`mcp__figma__*` write capability, or `use_figma`) creates/updates the frames described in the plan inside the target Figma file. If write capability isn't available in this session, stop and surface the gap — do not fake the push.
3. **Export (handoff)** — when a designer finishes a Figma edit, hand its output to `adapter.export()`.

## How to use

### Step 1 — Build the push plan

```bash
bongos exec scripts/gds/figma-design-sync.js
```

To limit to one surface:
```bash
bongos exec scripts/gds/figma-design-sync.js --surface <id>
```

### Step 2 — Push to Figma

Use the live Figma MCP tool to realize each frame in `figma-plan.json` as real nodes (rectangles for swatches, text nodes for typography specimens). Confirm the target Figma file with the builder before writing — never assume which file.

### Step 3 — Receive the designer's edit (export)

Figma hands back one of two shapes, depending on whether Code Connect is wired for the component:

**Code Connect output (ready code — the common case):**
```js
const adapter = require('./src/ui/adapters/figma/index.js');
await adapter.export({
  repoRoot: process.cwd(),
  surfaceId: '<surface-id>',
  toolOutput: { files: [{ path: 'Card.js', content: '...' }] },
  taskId: '<gds-task-id>',
});
```

**Raw Figma MCP node snapshot (no Code Connect mapping yet):**
```js
await adapter.export({
  repoRoot: process.cwd(),
  surfaceId: '<surface-id>',
  toolOutput: { snapshot: { nodes: [/* Figma node objects */] } },
  taskId: '<gds-task-id>',
});
```

The adapter translates simple frames/text/solid-fill rectangles into code. A node with an image or vector fill (icons, illustrations, freeform art) comes back as a `warnings[]` entry telling you to export it as an asset under `assets/ui/<surfaceId>/` instead — it is never silently dropped, and never forced into code it can't honestly represent.

## Fidelity limit (be upfront about this)

Round-trip fidelity is limited to what Code Connect or the Figma MCP can extract (ADR 0081). Arbitrary canvas art (icons, illustrations, freeform vector work) becomes a committed asset, not round-tripped code — that is the honest cost of the human escape hatch, not a bug.

## Code-canonical vs. Figma-canonical

Code-canonical is the default: the repo is authoritative, Figma is a synced view. A surface may be flagged `"figmaCanonical": true` in `config/design-sources.json` as an explicit exception (docs/design-contract.md §3.4) — only do this when the builder explicitly asks for a surface a designer actively iterates on in Figma.

## Path safety

The export step enforces path safety: no file (or translated snapshot node) may escape `src/ui/<surfaceId>/` or `assets/ui/<surfaceId>/`. A path-escape attempt throws before any write.

## After using this skill

- New `config/design-sources.json` entries from `export()` should be committed alongside any generated UI code.
- Run `bongos exec scripts/gds/validate-design.js` after touching adapters or design-sources — it's wired into `scripts/gds/fitness.js` as a hard-fail once any adapter is present.
- This is the UI-surface loop (ADR 0081). For pixel-art tile review in the amazonprimea Figma file, use `otb-figma-sync` instead — the two skills never touch the same Figma file or the same directories.
