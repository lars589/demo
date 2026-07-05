---
name: feedback
description: Pull the latest Bongos feedback bundle into this Claude Code session — the prompt.md walkthrough the Bongos app wrote (transcript + the ask) plus the screenshots it captured, loaded by absolute path so the Read tool can see them. Triggers when the user says "/feedback", "pull in my latest feedback", "load my bongos feedback", "I just recorded a walkthrough", "grab the latest feedback bundle", or "act on my screen recording". Local + read-only; no GDS auth needed.
---

You are pulling in the **latest Bongos feedback bundle** — a self-contained capture the user just recorded with the Bongos desktop app (BV1.R13 / [ADR 0087](../../../docs/adr/0087-bongos-app-architecture-and-handoff-contract.md)). The app turns a spoken screen walkthrough into a model-agnostic `prompt.md` (a timestamped transcript + an ask) plus a handful of screenshots, all under `~/CloudBongos/feedback/`. This skill loads that bundle so you can act on it directly — no copy-paste, no clipboard-image fiddling.

## Steps

1. **Resolve + print the latest bundle:**

   ```bash
   bongos exec scripts/gds/feedback-latest.js
   ```

   This prints the full `prompt.md` body followed by an `attached frames` list — one **absolute image path** per line. (Add `--json` if you want structured output instead.)

2. **If it says "No feedback bundle found"** — tell the user there's nothing to load yet: record a walkthrough in the Bongos app and stop the capture (that writes the bundle), then run `/feedback` again. Stop here.

3. **Read every listed frame.** For each absolute path under `attached frames`, call the **Read** tool on it so the screenshots enter your context as images. The paths are real files on disk — Read them directly; do not ask the user to paste anything.

4. **Act on the bundle.** Treat the transcript in `prompt.md` as the request and the screenshots as ground truth for what the user was looking at (the timestamps line the words up with the images). Work out what they want changed or fixed and do it. Ask a question only if you are genuinely blocked.

## Notes

- **Read-only + local.** The helper only reads files under `~/CloudBongos/feedback/`; it needs no GDS session and no network.
- **"Latest" = most recently produced.** The Bongos app updates a `latest` pointer every time a capture is stopped, so this always loads the newest walkthrough. To act on an older one, point the user at the specific dir under `~/CloudBongos/feedback/`.
- **The frames are file paths, never base64** — that's the whole point of the bundle format (it keeps the text prompt tiny and lets your Read tool load the images). See `bongos-app/README.md` for the full bundle contract.

## Files this skill touches

- Runs: `bongos exec scripts/gds/feedback-latest.js` (resolves via `bongos-app/src/handoff.js`).
