---
name: session-handoff
description: Emit a clean, paste-ready "next-steps" prompt to start a FRESH session with — so the next session begins with tight, curated context instead of dragging the whole transcript forward. Triggers when the user says "/session-handoff", "hand off to a fresh session", "give me a handoff prompt", "wrap up context for next time", "write the next-steps prompt", "I want to continue this in a new session", or "context is getting heavy, prep a fresh start". Read-only — it composes text, it changes no state.
---

You are producing a **handoff prompt**: a single, self-contained block of text the builder will **copy and paste as the first message of a brand-new session** to continue this work with a clean, light context.

This is NOT the ship handoff and NOT the session close-out:
- `/builder-ship` records handoff **notes** into the project ledger (backward-looking, for the record).
- `/builder-end` **closes** the current session (resolve claim + teardown).
- **This skill** writes the **starter prompt for the NEXT session** (forward-looking, for a human to paste). It resolves nothing and ships nothing.

Use it at the end of a working session, or mid-session when the context is getting heavy and you'd rather continue fresh without losing the thread.

## What to produce

Emit **exactly one fenced code block** (so it's trivially copy-pasteable) containing the prompt below. Write it for a reader — and a future Claude session — that has **none** of this conversation's context: be specific, name files by path, and spell out task ids as hall links, never a bare `#NNN`.

Keep it **short and curated** — a prompt, not a transcript. Include only what the next session needs to act. Use these sections, dropping any that are genuinely empty:

1. **Goal / where things stand** — one or two lines: the overall objective and the current state.
2. **Done this session** — a few bullets of what actually landed, each tagged `verified-prod` | `verified-smoke` | `implemented-not-verified` so the next session trusts the right things.
3. **Next steps** — the ordered, concrete actions to take next. Name the exact files, functions, and task ids (as hall links). Lead with the single most important one.
4. **Manual checks to run first** — anything the next session should verify before building on this work (a test to run, a page to load, a status to confirm).
5. **Gotchas / watch-outs** — traps you hit or foresee (a stale-tooling merge, a flaky step, a gated path, a decision still open).
6. **Pointers** — key files, ADRs, the relevant claim/task, and where to look. A short map so the next session doesn't re-hunt.
7. **First action** — the literal first thing to do in the fresh session, e.g. "Run `/builder-reauth` then `/builder-start`," or "Claim [#1234](<buildersOrigin>#/task/1234) into a fresh `task-1234` worktree."

## How to compose it

- **Ground it in this session.** Pull the "Done" + "Next steps" from what actually happened here — the claims you worked, the files you touched, the decisions you made. If you hold an active claim, name it and its status.
- **Mirror `docs/handoff-template.md`** for the section shape, but condense: a starter prompt is a fraction of a full session log.
- **Self-contained.** Assume the fresh session starts cold. Every reference (file, task, ADR, URL) must be resolvable without this chat.
- **Improvable.** If the builder edits the draft, keep their changes — this is their prompt to reuse and refine, not a fixed artifact.

## Constraints

- **Never include secrets** — no tokens, passwords, or the CLI session bearer. If a step needs a credential, name where it lives (Settings, `~/.config/otb/…`), never the value.
- **Task/idea/blocker ids are hall links** (`[#NNN](<buildersOrigin>#/task/NNN)` using `domains.buildersOrigin`) or plain `task NNN` — never a bare `#NNN` (it mis-autolinks to GitHub and 404s).
- **One fenced block, copy-clean.** No prose outside the block except a one-line "here's your handoff prompt — paste it into a fresh session" lead-in.
- Read-only: this skill composes text and changes no state. It does not claim, ship, release, or write files.

## Files this skill touches

- Reads (for grounding, optional): the current session context, `docs/handoff-template.md`, and — if useful — the active claim via `bongos exec scripts/gds/api.js GET /me`.
- Writes: nothing. Its only output is the handoff prompt printed in chat.
