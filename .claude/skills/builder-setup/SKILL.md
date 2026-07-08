---
name: builder-setup
description: One-time setup for a new builder on the Off the Boats project management system. Triggers when the user says "/builder-setup", "set up builder", "register me", "set up GDS", or when a builder slash command fails with "no GDS session." Authenticates the user against GitHub via Device Flow and stores a session token at ~/.config/cloudbongos/gds-session.json so future /builder-* commands work. If a valid session already exists for another account on this machine, setup.js asks whether to continue as that builder or sign in as a different one (multi-builder-on-one-device gate).
---

You are running the one-time setup that registers this Claude Code installation as a builder on the Off the Boats GDS.

## Background

The GDS authenticates builders against GitHub via OAuth Device Flow. The auth happens inside the terminal: the script prints a code, the user opens a URL, types the code, the script polls until it gets approval. The setup is builder-agnostic — every path is resolved from the current user's home directory, so this works on any developer's machine.

Before running this skill, **two things must be true**:

1. The droplet has GitHub OAuth client credentials available (env vars `GDS_GITHUB_CLIENT_ID` / `GDS_GITHUB_CLIENT_SECRET`, or `~/.config/cloudbongos/gds-github.json`). If not, the API returns `auth_not_configured` and the skill should explain that to the user and point at `blockers/blockers.md#github-oauth-app`.
2. The user has a GitHub account.

## What this skill does

Runs `bongos setup`. The script:

1. POSTs `/api/gds/auth/device/start` → gets `user_code` + `verification_uri` from GitHub via the server.
2. Prints a clear "open this URL, enter this code" prompt to the user.
3. Polls `/api/gds/auth/device/poll` every few seconds until the user approves (or denies, or expires).
4. On success, writes `~/.config/cloudbongos/gds-session.json` (resolved from the current user's `$HOME`) with the bearer token and builder profile.
5. Prints the builder's profile.

## How to use

1. **(Optional) Preview first** with `--dry-run`:
   ```bash
   bongos setup --dry-run
   ```
   Prints every step the real run would take — which API endpoints it would hit, where it would write the session file, which TTY prompts it would show — without doing any of them. Recommended for newcomers who want to see what's about to happen before running for real.

2. **Run setup**:
   ```bash
   bongos setup
   ```
   If the user has previously authenticated and just wants to re-auth, add `--force`.

   **Multi-builder-on-one-device gate (#533).** The session file lives at one global path per machine (`~/.config/cloudbongos/gds-session.json`), so a device can only hold one builder's session at a time. If a *valid* session already exists, setup.js no longer silently adopts it — on an interactive shell it asks: **[1] continue as that builder** or **[2] set up as a different builder** (sign in again, replacing the saved session). **Default to [1] / continuing as the existing builder.** Do NOT proactively pitch switching accounts, suggest signing in as someone else, or imply the builder should move to a more-privileged (e.g. Archon) account — that's a decision the builder (or an Archon) raises explicitly, not something setup offers. Only pick **[2]** when the user has clearly stated they are a *different* person than the one shown. Non-interactive shells (CI/batch) keep the existing session; a caller who genuinely needs a different identity passes `--force` themselves.

3. **Read the output back to the user** — relay the verification_uri and user_code clearly, since they need to act on it. Don't summarize; the user needs the literal code and URL.

4. **Wait** while polling completes. The script prints dots. If the user says they've finished, it'll be picked up on the next poll within a few seconds.

5. **Confirm** when authentication completes. The session file is at `~/.config/cloudbongos/gds-session.json` (chmod 600) — where `~` is the current OS user's home directory, whoever they are.

6. **Suggest next step.** The Xenos path is action-only (#766) — no primer to read first. `setup.js` prints a "Newcomer path" footer (1. choose thy craft · 2. `/builder-start` · 3. `/builder-claim N` → `/builder-ship` · 4. ship three works and you rise to Thetes); relay it verbatim instead of paraphrasing. For a returning builder (rank ≥ Metic), `setup.js` prints no newcomer footer and `/builder-start` is the right immediate next step.

## Constraints

- **Never write the session token to chat or any file other than `~/.config/cloudbongos/gds-session.json`.** It's a bearer token equivalent to a GitHub OAuth grant for this user.
- **If `auth_not_configured` is returned**, do NOT keep polling or trying to recover — explain to the user that an Archon needs to register the GitHub OAuth App and provide credentials on the server. Point them to `blockers/blockers.md#github-oauth-app`.
- **`GDS_API_BASE` env var** can override the API endpoint. Default is `https://demo.cloudbongos.com`. For local dev: `GDS_API_BASE=http://localhost:3000`.
- **`HOME` env var override** — `setup.js` (and the rest of the GDS CLI) resolves every path via `os.homedir()`, which honors `$HOME`. Tests can simulate a fresh-user setup by running the script with `HOME=/tmp/some-dir`. See `tests/setup_smoke.mjs` for the smoke test that exercises this.

## Files this skill touches

- Reads (potentially): `~/.config/cloudbongos/gds-session.json` (only to check if already authenticated)
- Writes: `~/.config/cloudbongos/gds-session.json`
- Calls: production `/api/gds/auth/device/start` and `/api/gds/auth/device/poll`
