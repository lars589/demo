---
name: read-session-export
description: Read a Claude Code `/export` zip quickly and consistently — the conversation, the assistant's thinking ("the thoughts"), and what the tools did — so you can answer questions about a past session. Triggers when the user drops a `session-export-*.zip` (or names one) and says "read this session", "what happened in this session", "what was I/you thinking here", "summarize this export", "read the latest session export", or "/read-session-export". This READS the existing export — it does not create a new one. Local + read-only, no GDS auth, no network.
---

The user already has the zip — Claude Code's built-in `/export` made it. Your job is to **read it well**: a session export is the same shape every time, so don't go spelunking through it by hand or load the megabytes of debug logs. Run the reader, which prints a compact transcript (prompts + thinking + replies + one-line tool calls) to stdout, then answer whatever the user actually asked.

```bash
bongos exec scripts/gds/read-session-export.js <export.zip>     # read it (compact transcript → stdout)
bongos exec scripts/gds/read-session-export.js --latest         # newest session-export-*.zip in ~/Downloads
```

Then **read that output and respond to the user's real intent** — summarize the session, pull out the reasoning behind a decision, find where something went wrong, list what was built. Don't just paste the transcript back; that's the raw material, not the answer.

## Pick the right depth (it's fast either way)

| The ask | Run |
|---|---|
| "What is this / how long / what model" | `--meta` (header only: model, dates, counts) |
| "What was I/you *thinking*" | `--thoughts` (only the 💭 thinking blocks) |
| Normal "read / summarize this session" | _(no flag)_ — compact transcript, tool results clipped |
| "I need the full tool output / exact text" | `--full` (loosens the result clipping) |

For a long session (a `--meta` showing hundreds of tool calls / thousands of lines), start with `--meta`, then `--thoughts` or a targeted read — don't dump the whole thing into context if the user only wants the gist.

## What you're reading (the constant layout)

A `/export` zip is identical every time, which is why this is reliable:

- `metadata.json` — model, effort, title, cwd, branch, timestamps.
- `<cliSessionId>.jsonl` — **the transcript**, one JSON record per line. Assistant records carry `content[]` blocks of type `thinking` (the thoughts), `text` (the reply), and `tool_use`; the matching `tool_result` rides in the next `user` record. The reader stitches these together.
- `<cliSessionId>/subagents/agent-*.jsonl` — subagent transcripts (rendered after the main one).
- `<cliSessionId>/tool-results/*.txt` — outputs too big to inline.
- `logs/*.log` — app debug logs. **Not the conversation** — ignored.

You rarely need this — the reader handles it — but it's here so you can read a record by hand if you must.

## The thinking may be redacted — and what to show instead

Whether "the thoughts" are actually readable depends on the model that ran the session, not on this tool:

- **Sonnet sessions** → thinking exports as plaintext; you'll see the real reasoning.
- **Opus sessions** (e.g. `claude-opus-4-8`) → thinking is **redacted**: the export carries only an encrypted signature, not the words. The reader states this once in the header (`💭 0 thoughts (+N redacted)` + a one-line banner) and otherwise keeps the body clean.

**The substitute for redacted thinking is already in the transcript — not in the logs.** When the thoughts are encrypted, lean on what Claude actually *said and did*: the **text replies** routinely state the reasoning in plain language ("the problem is X, so I'll Y"), and the **tool-call sequence** shows the investigation step by step. The reader surfaces both, so you can reconstruct the "why" of a redacted session from its actions. (The zip's `logs/*.log` are NOT a fallback: they're app-wide, multi-day rolling logs with no per-session correlation and no reasoning — ignore them.)

So if the user exported an Opus session hoping to re-read the literal reasoning, tell them plainly it's redacted — then answer their question anyway from the text + actions, which usually makes the reasoning clear.

## Constraints

- **Reads, never writes.** Output goes to stdout for you to consume; it creates no files and never modifies the zip.
- **Local + zero-dependency.** Pure Node stdlib (a small `zlib` ZIP reader) — no GDS session, no network, no install. Works on any builder machine.
- ZIP64 archives (multi-GB) are refused with a clear message; no real session export hits that.

## Files this skill touches

- Runs: `bongos exec scripts/gds/read-session-export.js` (the whole implementation).
- Reads: the `session-export-*.zip` you point it at. Writes: nothing.
