---
name: builder-key
description: List which API keys are set/unset for the caller, render a visual "key needed" callout for anything missing, and drive the UI-first add flow (open Settings, then re-sync + confirm). Triggers when the user says "/builder-key", "/api-key", "what keys do I have set", "do I have a Gemini key", "add my art key", "my key isn't working", or when the art pipeline errors with "No image-generation key found". HARD RULE: never accept a key pasted in chat — always redirect to Settings.
---

**Script skill (authoritative).** The core action is `bongos exec scripts/gds/key-status.js [--recheck]`. Run it and relay its output — the monospace status list, plus the visual callout it emits for any missing key (rendered per the marker convention below).

You are checking the current builder's API-key coverage (today: the art pipeline's Google AI Studio / Gemini key; the script is written to add more keys without new code).

## HARD RULE — never accept a key in chat (idea 347 / feedback_auth_flows_ui_first)

A key is **never** pasted into chat, and **never** accepted as a CLI argument. The only place a key is ever written is the Settings page (`PUT /me/art-key/own`, driven by the browser). If the user pastes what looks like a key into the conversation:

- **Do not** run it through any tool, echo it back, or forward it anywhere (the transcript is uploaded — a pasted key is now compromised the moment it's typed).
- Refuse, and point them back to Settings: `https://demo.cloudbongos.com/builders/settings#art-key`.
- `key-status.js` also refuses defensively if a key-looking string reaches it as an argument — that is a backstop, not the primary defense. The primary defense is **you never run it there in the first place**.

## How to use

1. **List status.** Run `bongos exec scripts/gds/key-status.js` and relay its output verbatim (the monospace list). It hits `GET /api/gds/me/art-key` for each known key.

2. **Missing key → the visual callout fires automatically.** When a key is unset, the script calls `scripts/gds/key-card.js` itself and prints `[otb-key-card-html] <path>` — the same marker the `.claude/hooks/lifecycle-card.js` PostToolUse hook scans for on ANY Bash output. The hook injects a render directive right after the tool result:
   - If you have `mcp__visualize__show_widget`: call `mcp__visualize__read_me` once this session (modules `["interactive","mockup"]`) if you haven't, then render the HTML exactly as directed — **once**, no prose recap.
   - If you don't have that tool: the monospace card the script already printed IS the summary — relay it as-is.

3. **Drive the UI-first add flow.** Tell the user to click "Add it in Settings ↗" in the card (or open `https://demo.cloudbongos.com/builders/settings#art-key` themselves). The key syncs to their box automatically at next session start via `scripts/gds/fetch-art-key.js` — no further action needed from you.

4. **Confirm it resolved.** Once the user says they added it, run `bongos exec scripts/gds/key-status.js --recheck` — this re-syncs the local session file immediately (rather than waiting for next session start) and re-checks status. Relay the result: resolved (all set) or still missing (point back to step 2/3).

## Constraints

- **Never** write a script, one-liner, or curl command that takes a key as an argument or env var supplied inline in chat — that's the same violation as pasting it, just automated.
- **Don't invent new key types speculatively** — `KEYS` in `key-status.js` lists only keys that actually have a backing route (today: `gemini`/art-key). Adding a new key type is a small script edit, not a new skill.
- If `GET /me/art-key` is unreachable (offline, API error), say so plainly — don't guess at status.

## Files this skill touches

- Reads: `~/.config/cloudbongos/gds-session.json`
- Calls: `GET /api/gds/me/art-key`, `GET /api/gds/me` (widgets knob)
- Runs: `scripts/gds/key-status.js`, `scripts/gds/key-card.js` (via the status script), `scripts/gds/fetch-art-key.js` (via `--recheck`)
