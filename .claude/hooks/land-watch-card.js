#!/usr/bin/env node
// task 1687 — deliver the SHIPPED banner once an async CI land completes.
//
// ## Why this hook
//
// In CI deploy mode /builder-ship exits at status=confirmed and the real
// confirmed->shipped land happens minutes later, server-side. So the last card
// the builder saw was "confirmed — landing"; the shipped success banner never
// rendered in-session. ship.js drops a pending-land breadcrumb at confirmed-exit
// (scripts/gds/land-watch.js owns the schema); THIS UserPromptSubmit hook, on a
// later prompt, asks the watcher whether anything has landed and — if so —
// injects the shipped card + the same one-step render directive the read-only
// cards use (session-cards.js's buildAdditionalContext, reused verbatim).
//
// ## Discipline (mirrors session-cards.js / conductor.js)
//
// Idle fast-path: no breadcrumb → return before any network (the common case, so
// the per-prompt cost is a cheap fs readdir). Bounded: the status lookups race a
// short timeout so a hung network can never stall a prompt. Silent-failure: any
// error → exit 0, no output. ZERO model calls. In-process (no subprocess) so the
// watcher resolves the instance config dir itself — nothing is hardcoded here.

const path = require('node:path');
const fs = require('node:fs');

const WATCH_TIMEOUT_MS = 8000;

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }

async function main() {
  // Kill-switch + subagent guard (mirrors session-cards.js): never fire inside a
  // grading/worker subagent, and honor the manual off-switch.
  if (process.env.OTB_SESSION_CARDS_OFF || process.env.OTB_SUBAGENT) return;
  readStdin(); // drain the payload; we don't need the prompt (land-watch is prompt-independent)

  let landWatch;
  let buildAdditionalContext;
  try {
    landWatch = require('../../scripts/gds/land-watch');
    ({ buildAdditionalContext } = require('./session-cards.js'));
  } catch (_) {
    return; // module chain unavailable (fresh clone / mid-rebase) → no-op
  }

  // Idle fast-path — no pending land → do nothing (no network, no card).
  let pending = [];
  try { pending = landWatch.readBreadcrumbs(); } catch (_) { return; }
  if (!Array.isArray(pending) || pending.length === 0) return;

  // Bounded: a landed task renders its shipped card; a hung lookup can't stall the prompt.
  let envelope = null;
  try {
    envelope = await Promise.race([
      landWatch.watch(),
      new Promise((resolve) => setTimeout(() => resolve(null), WATCH_TIMEOUT_MS)),
    ]);
  } catch (_) { return; }
  if (!envelope) return;

  const ctx = buildAdditionalContext(envelope, envelope.title || 'lifecycle_card');
  if (!ctx) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }) + '\n');
}

if (require.main === module) {
  main().catch(() => { /* never break a prompt */ }).finally(() => process.exit(0));
}

module.exports = { main };
