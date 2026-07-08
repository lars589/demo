---
name: builder-box
description: Show the builder their own dev box — state, IP/hostname, cost, and their registered SSH keys — and help them get (back) on it: (re)connect, queue a hands-off auto-provision/wake (POST /box/ensure, #701), fetch the browser-terminal URL + password for a Chromebook (ADR 0038, #760), or find their live game-preview "sandbox" URL (ADR 0044, #898). Triggers when the user says "/builder-box", "what's my box doing", "is my box up", "my dev box status", "show my box", "list my ssh keys", "wake my box", "create my box", "how do I get back on my box", "what's my sandbox URL", or "preview my game". Own-scoped — the only mutation it may trigger is queuing an auto-provision/wake of the caller's OWN box; it never parks or destroys (that is the operator's `bongos exec scripts/gds/box.js`).
---

You are showing a builder the status of **their own** dev box and helping them get (back) onto it. This is a read-only, own-scoped helper — it never mutates infrastructure (provision / park / wake / deprovision live on the operator control plane, `bongos exec scripts/gds/box.js`, gated by rank).

## Background

The per-builder box lifecycle (ADR 0031 §2) auto-suspends when idle (snapshot-and-park) and recreates on demand, so a builder's box is often `parked` between sessions — that's normal and cheap, not a problem. The read API:
- `GET /api/gds/box/me` → the caller's box: `state`, `scope`, `ip`, `hostname`, cost, activity timestamps.
- `GET /api/gds/box/ssh-key` → the caller's registered SSH keys (fingerprints + labels).
- `GET /api/gds/box/terminal` → the caller's active box's browser-terminal `url` + basic-auth `credential` (the Chromebook/browser on-ramp, ADR 0038), once the box has published them.

**The hands-off on-ramp (#701).** A builder no longer needs an operator to get or wake a box. `POST /api/gds/box/ensure` is the "make my box ready" button: it **auto-provisions** if they have no box, or **wakes** a parked one — by queuing a request the control plane runs within ~1 min (the web server never touches DigitalOcean directly). For a Chromebook, after `ensure` reports `active`, `GET /box/terminal` returns the terminal `url` + `credential` (ADR 0038) to open in the browser.

## How to use

1. **Fetch the box + keys** (own-scoped; uses the builder's session token):
   ```bash
   node -e 'const{apiCall}=require("./scripts/gds/cli-lib");(async()=>{for(const p of ["/api/gds/box/me","/api/gds/box/ssh-key"]){const r=await apiCall("GET",p);console.log(p,r.status,JSON.stringify(r.data));}})()'
   ```
   (If the script returns "no GDS session", run `/builder-setup` first.)

2. **Relay it in plain language:**
   - **state = `none`** → they have no box yet. On a Mac/Windows: run `/builder-connect` (registers their SSH key + installs the Desktop file). To actually create the box hands-off, `POST /api/gds/box/ensure` queues the auto-provision (no operator CLI needed). *(The old path — ask an operator to `box.js onboard <login>` — still works but is no longer required.)*
   - **state = `active`** → box is up at `hostname` (`ip`). They can connect from Claude Desktop → Code → Environment → "Amazonprimea Dev Box". For a browser/Chromebook (ADR 0038), the terminal comes from the web: `GET /api/gds/box/terminal` returns a `url` + a basic-auth `credential` (username `otb`, password = `credential`); open the url, enter them, then type `claude` in the terminal. No SSH needed.
     - **Live game preview — the sandbox (ADR 0044).** If `/box/terminal` returns a `url` (i.e. the box is on the named tunnel), the builder also has a private live preview of the game running on their own box, at the **same hostname with `term-` swapped for `sandbox-`** — e.g. terminal `https://term-<login>.demo.cloudbongos.com` → preview `https://sandbox-<login>.demo.cloudbongos.com`. It serves their working copy of the game (degraded — fully playable, no saved state), so they can review changes in a browser **without shipping to prod**. The loop: edit in the terminal → run **`/builder-stage`** (or `box-preview restart`) → refresh the preview tab. Staging via `/builder-stage` also records the review marker that `/builder-ship`'s sandbox-first gate checks (#927, ADR 0046) — on a dev box, game changes are staged + reviewed on the sandbox before they ship to the main game. `box-preview status` shows whether it's up + the URL; `box-preview logs` tails the server. (No preview on a quick-tunnel box — that path can't carry the game port; it needs the named tunnel.)
   - **state = `parked`** → idle-suspended (cheap, expected). It wakes on demand: `POST /api/gds/box/ensure` queues the wake and it's back in ~1 min (no operator needed). Reassure them their data is safe in the snapshot.
   - **state = `provisioning` / `waking`** → in flight; check back in a minute.
   - **state = `error`** → flag it to an operator (don't try to fix infra from here).
   - **SSH keys** → list the fingerprints + labels. If empty, they haven't connected yet → `/builder-connect`. They can remove a stale key with `DELETE /api/gds/box/ssh-key/:id` (own-scoped).

3. **Cost framing (if asked):** a box only bills compute while `active`; parked costs ~$0.30/mo (just the snapshot). The number in `compute_cost_usd` is their box's running total.

## Constraints

- **`POST /box/ensure` is the only mutation a builder may trigger** — and it only *queues* an auto-provision/wake of their **own** box (rank-gated, one open request at a time); the web server never touches DigitalOcean. Never call provision/park/wake/**deprovision** directly — those are operator control-plane commands (`bongos exec scripts/gds/box.js`), rank-gated. If the builder wants their box destroyed, that's an operator action.
- **Own resource only.** `/box/me` and `/box/ssh-key` are scoped to the caller. The full roster (`GET /api/gds/boxes`) is Archon-only — don't try it for a regular builder.
- **Don't print the SSH private key** — these endpoints only ever return public fingerprints, never private material. Keep it that way.

## Files this skill touches

- Calls: `/api/gds/box/me`, `/api/gds/box/ssh-key` (read), `/api/gds/box/terminal` (read), optionally `POST /api/gds/box/ensure` (queue auto-provision/wake) or `DELETE /api/gds/box/ssh-key/:id`
- Reads: `~/.config/cloudbongos/gds-session.json` (the session token, via cli-lib)
