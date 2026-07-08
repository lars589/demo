---
name: builder-connect
description: One-command connect of the builder's Claude Desktop to their Amazonprimea dev box (ADR 0031, #685). Triggers when the user says "/builder-connect", "connect me to the dev box", "set up my dev box", "connect Claude Desktop to the box", or "onboard me to the box". Runs the self-contained bootstrap that signs the builder in with GitHub, creates + registers their SSH key, and installs the Claude Desktop connection file — then tells them to restart Desktop and pick "Amazonprimea Dev Box". This is the BUILDER side; the OPERATOR side is `bongos exec scripts/gds/box.js onboard <login>`.
---

You are guiding a builder through connecting their **own machine's** Claude Desktop to their org dev box. The audience is often non-technical — narrate each step in plain language, and never make them hand-edit files or paste keys around. One command does everything.

## Background (the mental model — ADR 0031)

Claude Code is three pieces: the **screen** (their device — always local), the **worker** (the dev box — where the repo + work live), and the **brain** (Anthropic's servers). This skill wires the screen to the box. The box itself is provisioned by an operator with `bongos exec scripts/gds/box.js onboard <login>`; this skill is the builder's half — it registers their SSH key and installs the Desktop connection file so the box shows up as a one-click "Environment".

What the bootstrap does, in order:
1. **GitHub sign-in** (device flow against the GDS — it prints a short code + a URL to open).
2. **Creates an SSH key** at `~/.ssh/otb_builder` if absent (the private half never leaves their machine).
3. **Registers the public key** with the GDS (`POST /box/ssh-key`). The box pulls it into `authorized_keys` itself — no operator SSH round-trip.
4. **Downloads + installs** the Claude Desktop connection file (`managed-settings.json`) at the OS path.

## How to use

1. **Decide which command to run.** Both do the same thing; pick by where you're running:
   - **Repo is present locally** (you can see `infra/box-connect.sh`): run the local copy —
     ```bash
     bash infra/box-connect.sh
     ```
   - **No repo** (a bare laptop with only Claude Desktop): run the hosted bootstrap —
     - macOS / Linux:
       ```bash
       curl -fsSL https://demo.cloudbongos.com/api/gds/box/connect.sh | bash
       ```
     - Windows (PowerShell):
       ```powershell
       irm https://demo.cloudbongos.com/api/gds/box/connect.ps1 | iex
       ```
   (For staging, swap the host — or set `GDS_API_BASE` before the local script.)

2. **Relay the GitHub code + URL verbatim.** The script prints a short user code and a `https://github.com/login/device` URL. The builder must open the URL and enter the code. Do not summarize — they need the literal values. The script also tries to pop the URL open automatically.

3. **Wait while it polls.** After they approve in the browser, the script registers the key and installs the connection file. On macOS the install step needs **one `sudo` prompt** (the file lives under `/Library/Application Support/ClaudeCode` — the dir Claude Code actually reads managed settings from; `…/Claude/` is silently ignored).

4. **Confirm the finish state and give the next steps:**
   - Tell their operator they're registered (so the operator runs `box.js onboard <login>` to provision the box, if not already done).
   - **Restart Claude Desktop.**
   - Open **Code → Environment → "Amazonprimea Dev Box"** to connect.

5. **Once they're on the box**, the first thing to do there is authenticate the GDS CLI (`/builder-setup` or `bongos setup`) so the box can pull rank-scoped source and keep their SSH keys in sync.

## Constraints

- **Never print or save the SSH private key or the GDS token anywhere except where the script puts them.** The private key stays at `~/.ssh/otb_builder`; the token is held only in memory on the laptop for the two authenticated calls (it is NOT persisted there — the box gets its own session when they authenticate Claude Code on it).
- **Don't re-generate a key if `~/.ssh/otb_builder` already exists** — the script reuses it. Overwriting would break an existing box connection. (The script handles this; don't override it.)
- **If `auth_not_configured` comes back**, the GDS has no GitHub OAuth app — stop and point them to an Archon (`blockers/blockers.md#github-oauth-app`). Don't loop.
- **Memory + credits are server-side** (ADR 0024) — reassure the builder that nothing about which box they land on affects their history.

## Files this skill touches

- Runs: `infra/box-connect.sh` (or the hosted `GET /api/gds/box/connect.sh` / `.ps1`)
- Reads/creates: `~/.ssh/otb_builder` (+ `.pub`)
- Writes (macOS): `/Library/Application Support/ClaudeCode/managed-settings.json`; (Windows): `%ProgramFiles%\ClaudeCode\managed-settings.json` — the dir Claude Code reads managed settings from. **Not** `…/Claude/` or `%ProgramData%\Claude\`, which the app ignores (the box then never appears in the Environment picker).
- Calls: `/api/gds/auth/device/{start,poll}`, `/api/gds/box/ssh-key`, `/api/gds/box/managed-settings`
