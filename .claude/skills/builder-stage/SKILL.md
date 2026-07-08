---
name: builder-stage
description: Stage the builder's current working tree on their own live game preview (the sandbox) so they can review a game change in a browser BEFORE shipping it to the main game (#927, ADR 0046). On a dev box the sandbox is sandbox-<login>.demo.cloudbongos.com (ADR 0044); on a LOCAL full clone (laptop) it is a private http://localhost:<port> preview (task 1056). Triggers when the user says "/builder-stage", "stage my work", "stage this on my sandbox", "let me see it before shipping", "preview this change", "show me the change running", or right before /builder-ship when game surfaces changed. Own-scoped and machine-local — it only (re)starts the caller's own preview (box service or local process); it never touches prod or other builders' machines.
---

You are staging a builder's in-progress work on **their own** sandbox — the live game preview running on their dev box (ADR 0044) — so they can see the change in a browser, suggest fixes, and only then decide to ship it to the main game (ADR 0046).

## Background

The script auto-detects where it's running and (re)starts the right preview — both serve the **game-only** entry (`src/preview-server.js`, ADR 0052), degraded-DB (fully playable, no saved state, isolated from prod, no `/api/gds`):

- **Dev box:** `box-game-preview.service` serves the `/workspace` tree at `https://sandbox-<login>.demo.cloudbongos.com` (ADR 0044). Staging restarts that service.
- **Local full clone (laptop):** a private detached process serves it at `http://localhost:<port>` (default 3100, `$CLOUDBONGOS_PREVIEW_PORT` to override), managed by `scripts/gds/local-preview.js` (task 1056). Staging (re)starts that process. No tunnel, no public URL — it never leaves your machine.

Either way staging = (re)start the preview, health-check it, and record a marker of exactly what tree state was staged. `/builder-ship` checks that marker: a game-surface diff that wasn't staged at its current state triggers the sandbox review gate before the claim resolves — on a box AND on a local clone.

## How to use

1. **Run the stage command** from the repo root (`/workspace` on a box; your clone root on a laptop):
   ```bash
   bongos exec scripts/gds/sandbox-stage.js
   ```
   It (re)starts the preview, waits until the game answers, writes the staged marker, and prints the review URL (the `sandbox-<login>` host on a box, or `http://localhost:<port>` locally).

   > **Local setup (laptop):** the preview needs the game's dependencies, so run `npm install` once in your clone. You can also drive the preview directly: `npm run preview` (start), `bongos exec scripts/gds/local-preview.js {status|restart|stop|logs}`. Reviewing via the Claude Code preview tools? A `local-sandbox` server is pre-wired in `.claude/launch.json`.

2. **Hand the builder the URL** and tell them plainly: this is *their* private copy of the game running on *their* box — nothing has shipped. Ask them to open it, walk around, and check the change.

   > **Generated art?** If the change was a pixel-art tile, the builder can also see it at the **`/art`** path of the same sandbox URL (`…/art`) — the generated-art gallery (#1262), which shows every tile they've made *even when it isn't placed in the game world yet*. Point them there when the work is "I made a tile" rather than "I changed the map."

3. **Collect their reaction:**
   - **Change requests** → make the edits, then re-run `bongos exec scripts/gds/sandbox-stage.js` and have them refresh the browser tab. Loop until they're happy.
   - **Looks right** → proceed to `/builder-ship`. The ship gate sees the fresh staged marker and carries on to the main game. (If the marker went stale — the game files changed after staging — the ship stages again and pauses with the review URL; show it to the builder, then re-run.)

4. **Useful sub-commands:**
   - `bongos exec scripts/gds/sandbox-stage.js status` — is the sandbox current with the working tree, when was it last staged?
   - `bongos exec scripts/gds/sandbox-stage.js url` — just the URL.

## Constraints

- **Box or local full clone.** A dev box stages to `sandbox-<login>`; a full local clone stages to `http://localhost:<port>`. The ONLY machine with no sandbox is a partial clone that lacks the game (`src/preview-server.js`) — there the script says so and exits.
- **Named tunnel required (box only).** A quick-tunnel box has no sandbox hostname (ADR 0044); the script says so. The fix is operator-side (`BOX_NAMED_TUNNEL=1` + re-provision), not something to debug here. (Local previews have no tunnel and aren't affected.)
- **On a dev box, the preview is the HOSTED `sandbox-<login>` URL — never localhost.** Get it from this skill (`bongos exec scripts/gds/sandbox-stage.js`) or `box-preview status`. Do **NOT** preview a box change with the Claude Code preview tools or `npm run preview`/`npm start`: those bind `http://localhost`, which the builder's own browser can't reach when the server is on a remote box — handing them a dead localhost link is the task-1443 footgun. (`sandbox-stage.js` now routes any box to the hosted URL and refuses to emit localhost; a box with no hostname gets a clear re-provision message, not a localhost link.) Localhost is correct ONLY on a laptop full clone.
- **Never present the sandbox as prod.** No credits, no broadcast, nothing shipped — staging is review, `/builder-ship` is the decision. The local preview is private to the builder's own machine (not shareable).
- If the preview won't come up healthy, point the builder at the logs — `box-preview logs` on a box, `bongos exec scripts/gds/local-preview.js logs` locally — rather than guessing.

## Files this skill touches

- Runs: `scripts/gds/sandbox-stage.js` (resolves box vs local; box → restarts `box-game-preview.service`; local → `scripts/gds/local-preview.js` + `local-preview-lib.js` (re)start `node src/preview-server.js`)
- Reads: `/etc/cloudbongos/box.env` (a box's `BOX_PREVIEW_HOSTNAME`); `$CLOUDBONGOS_PREVIEW_PORT` (local port, default 3100)
- Writes: the staged marker in the OS temp dir (`otb-sandbox-staged.json`); locally, the preview pid/log in the OS temp dir (`otb-local-preview.{pid,log}`)
