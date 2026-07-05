---
name: close-box
description: Tear down the dev box you are working on, from inside the box's terminal. Asks the GDS to deprovision the caller's own box (POST /box/close — the same action as the builders'-hall "Close box" button). Triggers when the user says "/close-box", "close my box", "shut down this box", "I'm done with this box", "tear down my dev box". Own-scoped — it deprovisions only the caller's own box; it never touches another builder's box or any other infrastructure (those live on the operator control plane, bongos exec scripts/gds/box.js).
---

You are closing (deprovisioning) the dev box the builder is currently working on. This is the Claude-side twin of the `close-box` shell command (`infra/close-box.sh`) — same endpoint, for builders who'd rather say "/close-box" inside `claude` than drop to the shell. It is own-scoped and destructive (the box is destroyed), so confirm before firing.

## Background

A per-builder dev box (ADR 0031 §2) is a DigitalOcean droplet. Closing it enqueues a `deprovision` intent that the control-plane runner executes within ~a minute. The box's disk is gone after that — anything in `/workspace` that was not pushed to its remote is lost. The box is cheap to recreate from the builders' hall ("Request dev box" / `/builder-box`), so closing when done is the right cost hygiene; the idle-suspend sweep would otherwise park it automatically after the idle window.

The endpoint:
- `POST /api/gds/box/close` → enqueues `deprovision` for the **caller's own** box (`auth.requireBuilder`, own resource). Idempotent-ish: if there's no active box it just no-ops.

## What this skill does

Calls `POST /api/gds/box/close` via the cross-platform helper, after confirming with the builder.

## How to use

1. **Confirm intent.** Ask plainly: "Close (deprovision) your dev box? Any work in `/workspace` you haven't pushed will be lost." Proceed only on a clear yes. If the builder only wants to stop *using* it for now (not destroy it), tell them they can just close the tab — with session persistence (#893) their work survives and the box auto-parks when idle — and do NOT close it.

2. **Fire the close:**
   ```
   bongos exec scripts/gds/api.js POST /api/gds/box/close
   ```
   (The helper resolves the GDS session token + API base itself; no manual token handling.)

3. **Relay the outcome.** On success tell the builder:
   - The box is closing now (a few seconds).
   - They can close the browser tab — and if the builders'-hall tab is still open in the background, it auto-closes the terminal tab for them when it sees the box shut down (`modules/hall-ui/public/box-panel.js`). This skill cannot close the tab itself (it has no browser control).
   - They can provision a fresh box anytime from the hall or with `/builder-box`.

## Constraints

- **Own box only.** This never deprovisions another builder's box. Operator-scoped lifecycle (provision / park / wake / destroy-any) lives in `bongos exec scripts/gds/box.js`, gated by rank — not here.
- **Don't auto-close without a yes.** It is destructive.
- **It cannot close the browser tab.** Be honest about that — see the relay step.

## Files this skill touches

- Reads: `~/.config/otb/gds-session.json`
- Calls: `POST /api/gds/box/close`
