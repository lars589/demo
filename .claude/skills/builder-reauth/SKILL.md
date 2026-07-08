---
name: builder-reauth
description: Refresh an expired or invalid GDS CLI session the fast, UI-first way — no terminal Device Flow. Triggers when the user says "/builder-reauth", "re-auth", "refresh my session", "my GDS session expired", "re-issue my CLI token", or when any /builder-* command fails with "GDS CLI session is no longer valid". Opens the builder's Settings page in the browser, the user clicks "Re-issue CLI token" under "CLI Access" and copies the one-liner, and this skill runs it to write the new session.
---

You are refreshing the current builder's GDS CLI session. CLI bearer tokens carry a 24h idle TTL (they refresh on every use), so an actively-used session stays alive — but an idle one expires, and a revoked one dies immediately. This skill is the **fast path back in**: browser clicks plus a single copy/paste, instead of the slower terminal Device Flow.

## Why expiry exists (so you can explain it if asked)

The idle TTL is auth-token hygiene (GDS-V3 criterion **C9**): the CLI token lives in a plaintext file (`~/.config/cloudbongos/gds-session.json`, mode 0600), so bounding the lifetime of a leaked or abandoned token matters. It is **not** what enforces rank changes — demotion calls `revokeAllSessionsForBuilder` synchronously and rank is read fresh from the DB on every request ([ADR 0016](../../../docs/adr/0016-trust-boundary-server-enforced-permissions.md)). So expiry stays; the friction is what this skill removes.

## The flow (guided paste)

1. **Detect.** Run the helper — it checks whether the existing session is still valid and, if not, opens the hall:
   ```bash
   bongos reauth
   ```
   - **Exit 0** → the session is already valid. Relay who they're signed in as and stop — there is nothing to do. Do NOT re-auth a working session.
   - **Exit 10** → re-auth is needed. The helper has opened (or printed) the builders' hall URL and the click-path. Continue to step 2.
   - **Exit 2** → the API was unreachable (network). Relay that, and let them retry once they're back online. The session may be fine.

2. **Relay the click-path verbatim.** The helper prints the exact steps; pass them to the user clearly (don't paraphrase the URL):
   - Open `https://demo.cloudbongos.com/builders/settings` (the helper tries to open it automatically; if not, give them the link).
   - They are already signed in there via the browser cookie. Under the **"CLI Access"** section, click **"Re-issue CLI token"**.
   - Click **"Copy"** — it copies a one-line command of the form `bongos exec scripts/gds/paste-token.js <token>`.
   - Ask them to **paste that one line back into the chat**.

3. **Run the pasted command.** When the user pastes `bongos exec scripts/gds/paste-token.js <token>`, run it exactly as given. `paste-token.js` verifies the token against `/api/gds/me` **before** touching the session file (a bad paste leaves the existing session intact) and preserves any `gemini_api_key`. On success it prints the builder login, rank, and confirms the session file was written.

4. **Confirm.** Relay the authenticated identity + rank back to the user, and tell them they can now re-run whatever `/builder-*` command they were trying.

## Edge cases

- **"You are not signed in" / `cookie_required`.** The re-issue endpoint mints CLI bearers from a browser *cookie*, not a bearer — a leaked CLI token can't extend its own life. If the Settings page shows them logged out, they sign in at `https://demo.cloudbongos.com/builders` first, then return to `/builders/settings` and click Re-issue. Once signed in the button works.
- **No session file at all (fresh machine).** The helper still guides them to the Settings page; if they've never authed on this machine, the hall sign-in + Settings → CLI Access → Re-issue path still works. The terminal Device Flow (`bongos setup`) remains the fallback for a brand-new builder with no browser session anywhere.
- **Browser can't open automatically** (headless / SSH). The helper prints the URL; relay it so they can open it on whatever machine has their browser, then paste the one-liner back.
- **Fallback — terminal Device Flow.** If the browser path is unavailable for any reason, `bongos setup --force` re-auths via GitHub Device Flow (terminal code entry). Slower and not UI-first; use only when the hall route can't be used.

## Constraints

- **The token briefly transits the chat — that's the known cost of guided-paste.** The user pastes `bongos exec scripts/gds/paste-token.js <token>` into the conversation, so the bearer appears in the chat (and any log/context that captures it). That's the accepted trade-off Lars chose; the deferred zero-paste loopback flow removes it. So: treat the session log as sensitive, **never echo the token beyond running that one pasted command**, and never write it to any file other than `~/.config/cloudbongos/gds-session.json` (`paste-token.js` is the only thing that should write it — let it do the write). The token rotates whenever the builder clicks Re-issue again, so re-running this flow invalidates an exposed paste's usefulness for an attacker who lacks the browser cookie.
- **Don't re-auth a valid session.** If `reauth.js` exits 0, stop.
- **`GDS_API_BASE`** overrides the endpoint (default `https://demo.cloudbongos.com`); for local dev `GDS_API_BASE=http://localhost:3000`.

## Files this skill touches

- Runs: `bongos reauth` (detect + open browser + print click-path)
- Runs: `bongos exec scripts/gds/paste-token.js <token>` (verify + write the new session)
- Reads/Writes (via paste-token.js): `~/.config/cloudbongos/gds-session.json`
- Calls: `GET /api/gds/me`; the Settings page (CLI Access) calls `POST /api/gds/auth/cli-token/issue`
