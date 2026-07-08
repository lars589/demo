#!/usr/bin/env node
// task 1288 — deterministic delivery of MUTATING lifecycle cards (claim, ship,
// release): the PostToolUse mirror of the read-only session-cards.js hook.
//
// ## Why a different vehicle than session-cards.js
//
// Read-only cards (builder-start, status) are safe to PRE-RUN, so session-cards.js
// runs their script on prompt-submit and injects the result. Lifecycle commands
// MUTATE state (claim locks a task, ship merges + deploys) — a hook must never
// pre-run them as a side effect of typing. So the model runs the script itself
// (via Bash), and THIS hook fires immediately after (PostToolUse), reads the card
// the script already produced, and injects it + a one-step render directive next
// to the tool result. Same methodology (script owns the card; a hook guarantees
// delivery; the model just emits), post-run vehicle.
//
// ## What the scripts emit (src/bongos/ship-card.js emitCard, shared by claim.js +
// ## ship.js + release paths)
//
//   widgets ON  → writes the HTML card to a temp file, prints `[otb-card-html] <path>`
//   widgets OFF → prints ONLY the plain-text card (task 1279 — no HTML at all)
//
// So this hook injects only on the widgets-ON marker. Widgets-OFF stays
// HTML-free: the plain-text card + its in-band `[otb-card]` directive are already
// in the tool output for the model to relay — nothing for this hook to add.
//
// ## Discipline (mirrors the other hooks)
//
// Silent-failure: wrong tool / non-lifecycle command / no marker / file gone /
// parse error → exit 0, no output. Never breaks a turn. Zero model calls. The
// only thing that reaches stdout is the additionalContext JSON.

const fs = require('node:fs');

// An actual `node …scripts/gds/{claim,ship,release}.js` invocation (not a mere
// mention like `ls …claim.js`). / or \ so it matches on any platform. The
// marker check below is the authoritative gate; this is the cheap pre-filter.
const LIFECYCLE_RE = /\bnode\s+\S*scripts[/\\]gds[/\\](?:claim|ship|release)\.js\b/;
// emitCard's widgets-ON marker; the path has no spaces, so \S+ captures it exactly.
const CARD_HTML_RE = /\[otb-card-html\]\s+(\S+)/;
// scripts/gds/key-card.js's widgets-ON marker (task 1391 — the "key needed"
// callout). Unlike the lifecycle marker above, this is NOT gated by
// matchesLifecycle: the card can surface from ANY Bash invocation that shells
// into a key check (the art pipeline's gen_api.py today, calling key-card.js as
// a subprocess; generalizes to future key integrations that do the same).
const KEY_CARD_HTML_RE = /\[otb-key-card-html\]\s+(\S+)/;

// Normalize a Bash tool_response (a string, or an object with stdout/stderr/…) to
// the text the script printed. Unknown shapes → '' (hook then no-ops safely).
function responseText(resp) {
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    return [resp.stdout, resp.stderr, resp.output, resp.content].filter((x) => typeof x === 'string').join('\n');
  }
  return '';
}

function matchesLifecycle(cmd) {
  return typeof cmd === 'string' && LIFECYCLE_RE.test(cmd);
}

// The `[otb-card-html] <path>` the script printed (widgets ON), or null.
function extractCardPath(out) {
  if (typeof out !== 'string') return null;
  const m = CARD_HTML_RE.exec(out);
  return m ? m[1].trim() : null;
}

// `task_<id>_card` from the temp filename (otb-ship-card-<id>.html), else generic.
function cardTitle(cardPath) {
  const m = /otb-ship-card-([\w-]+)\.html/.exec(cardPath || '');
  return m ? `task_${m[1]}_card` : 'lifecycle_card';
}

// The `[otb-key-card-html] <path>` key-card.js printed, or null.
function extractKeyCardPath(out) {
  if (typeof out !== 'string') return null;
  const m = KEY_CARD_HTML_RE.exec(out);
  return m ? m[1].trim() : null;
}

// `key_needed_<id>_card` from the temp filename (otb-key-card-<id>.html), else generic.
function keyCardTitle(cardPath) {
  const m = /otb-key-card-([\w-]+)\.html/.exec(cardPath || '');
  return m ? `key_needed_${m[1]}_card` : 'key_needed_card';
}

// Pure: the directive that rides next to the tool result. '' if no usable HTML.
function buildLifecycleContext(html, title) {
  if (typeof html !== 'string' || !html.trim() || typeof title !== 'string') return '';
  return [
    '[otb lifecycle card — pre-rendered by the script you just ran (task 1288). Render it ONCE; no prose recap, no rebuilt summary, no restating the claim/ship in words:]',
    `- If you have \`mcp__visualize__show_widget\`: call \`mcp__visualize__read_me\` once this session (modules ["interactive","mockup"]) if you haven't, then call \`show_widget\` with title "${title}" and widget_code set to EXACTLY the HTML fenced by the LIFECYCLE_HTML lines below. The card IS the summary.`,
    '- If you do NOT have `show_widget`: the plain-text card already in the command output is the summary — relay it as-is, do not call show_widget.',
    '',
    '<<<LIFECYCLE_HTML>>>',
    html,
    '<<<LIFECYCLE_HTML>>>',
  ].join('\n');
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; } }
function parsePayload(raw) { try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; } }

// Pure: the directive that rides next to the tool result for a key-needed
// callout. '' if no usable HTML.
function buildKeyCardContext(html, title) {
  if (typeof html !== 'string' || !html.trim() || typeof title !== 'string') return '';
  return [
    '[otb key-needed card — pre-rendered by the script that hit a missing key (task 1391). Render it ONCE; no prose recap, no rebuilt summary:]',
    `- If you have \`mcp__visualize__show_widget\`: call \`mcp__visualize__read_me\` once this session (modules ["interactive","mockup"]) if you haven't, then call \`show_widget\` with title "${title}" and widget_code set to EXACTLY the HTML fenced by the KEY_CARD_HTML lines below. The card IS the summary.`,
    '- If you do NOT have `show_widget`: the plain-text card already in the command output is the summary — relay it as-is.',
    '- Never ask the builder to paste the key in chat. The card already points them at Settings (UI-first only) — just relay the card.',
    '',
    '<<<KEY_CARD_HTML>>>',
    html,
    '<<<KEY_CARD_HTML>>>',
  ].join('\n');
}

function main() {
  if (process.env.CLOUDBONGOS_SESSION_CARDS_OFF || process.env.CLOUDBONGOS_SUBAGENT) return;
  const p = parsePayload(readStdin());
  if (p.tool_name !== 'Bash') return;
  const cmd = p.tool_input && p.tool_input.command;
  const outText = responseText(p.tool_response);

  // Key-needed callout (task 1391) — checked BEFORE the lifecycle gate below,
  // since the marker can surface from any Bash invocation, not just a
  // scripts/gds/{claim,ship,release}.js run.
  const keyCardPath = extractKeyCardPath(outText);
  if (keyCardPath) {
    let html = '';
    try { html = fs.readFileSync(keyCardPath, 'utf8'); } catch (_) { html = ''; }
    const ctx = html ? buildKeyCardContext(html, keyCardTitle(keyCardPath)) : '';
    if (ctx) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
      }) + '\n');
      return;
    }
  }

  if (!matchesLifecycle(cmd)) return;

  const cardPath = extractCardPath(outText);
  if (!cardPath) return; // widgets OFF / no card → the in-band plain-text directive handles it

  let html = '';
  try { html = fs.readFileSync(cardPath, 'utf8'); } catch (_) { return; } // file gone / race → silent
  const ctx = buildLifecycleContext(html, cardTitle(cardPath));
  if (!ctx) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
  }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (_) { /* never break a turn */ } finally { process.exit(0); }
}

module.exports = {
  matchesLifecycle, extractCardPath, cardTitle, buildLifecycleContext, responseText, LIFECYCLE_RE,
  extractKeyCardPath, keyCardTitle, buildKeyCardContext, KEY_CARD_HTML_RE,
};
