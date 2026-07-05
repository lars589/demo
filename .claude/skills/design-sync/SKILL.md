---
name: design-sync
description: Export the repo design system into Claude Design so prototypes start from real tokens and component surfaces, then land Claude Design's generated UI code back as a GDS task. Triggers when the user says "/design-sync", "sync design", "export tokens to Claude Design", "import to Claude Design", or "push design system".
---

You are helping the builder run the Claude Design sync loop: export the repo's design tokens and surfaces into Claude Design so any prototype starts from real values, not guesses.

## What this skill does

1. **Import** — `bongos exec scripts/gds/design-sync.js` builds a token-preview bundle (HTML color/typography/spacing/radii cards, `tokens.css`, `tokens.json`, `surfaces.json`) in a temp directory and prints a JSON manifest.
2. **Push** — the DesignSync MCP tool (`list_projects` → `finalize_plan` → `write_files`) uploads the bundle to a Claude Design project.
3. **Export (handoff)** — when Claude Design generates UI code, the handoff lands it under a claimed GDS task via `adapter.export()`.

## How to use

### Step 1 — Build the bundle

```bash
bongos exec scripts/gds/design-sync.js
```

Prints JSON to stdout: `{ bundlePath, files, surfaceIds, summary }`.

To limit to one surface:
```bash
bongos exec scripts/gds/design-sync.js --surface <id>
```

### Step 2 — Push to Claude Design

Use the **DesignSync MCP tool** (`mcp__DesignSync__*`):

1. `list_projects` — pick the target project (or create one).
2. `finalize_plan` — stage the file list from `manifest.files`, with `bundlePath` as the base.
3. `write_files` — push the staged files.

HTML files with `<!-- @dsCard group="Tokens" -->` appear as Design System cards in Claude Design.

### Step 3 — Receive Claude Design output (export)

When Claude Design finishes and hands off to Claude Code, call the adapter directly in Node:

```js
const adapter = require('./src/ui/adapters/claude-design/index.js');
await adapter.export({
  repoRoot: process.cwd(),
  surfaceId: '<surface-id>',       // e.g. "hall-ui"
  toolOutput: { files: [          // from Claude Design
    { path: 'components/Card.js', content: '...' },
  ]},
  taskId: '<gds-task-id>',        // optional — links the sync back to the claim
});
```

Files write to `src/ui/<surfaceId>/`. `config/design-sources.json` is updated with the sync timestamp and tool name.

## Token system

Tokens live in `config/design-tokens.neutral.json` (baseline) + `config/design-tokens.json` (instance override, merged on top). The adapter resolves the merged tree and emits `--dt-<group>-<key>` CSS vars in `tokens.css`. Full recipe: `docs/recipes/claude-design-loop.md`.

## Path safety

The export step enforces path safety: no file from Claude Design may escape `src/ui/<surfaceId>/` or `assets/ui/<surfaceId>/`. A path-escape attempt throws before any write.

## After using this skill

- The generated `tokens.css` is a read-only artefact (regenerated each sync) — do not hand-edit it.
- New `config/design-sources.json` entries from `export()` should be committed alongside any generated UI code.
- Full loop recipe (multi-iteration, troubleshooting, Figma coexistence): `docs/recipes/claude-design-loop.md`.
