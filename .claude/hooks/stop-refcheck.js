#!/usr/bin/env node
// stop-refcheck.js — Stop hook: the deterministic backstop for the THIRD #NNN
// → GitHub-404 surface, live session text. (Follow-on to shipped task 929.)
//
// THE PROBLEM (recap). When an agent types a bare "#286" in chat, the Claude
// desktop/CLI app autolinks it to the dev-box GitHub remote (…/issues/286),
// which 404s — GDS task ids are a SEPARATE number space from GitHub issues.
// task 916 fixed committed docs (linkify-refs.js) + commit/PR text (ship
// sanitizer); task 929 fixed the hall copy-prompt + wrote the CLAUDE.md rule.
// Both remaining controls are ADVISORY: nothing stops the model typing a bare
// "#NNN" live. This hook is the one project-wide, deterministic lever for that
// surface — it lives in .claude/settings.json, so it reaches every builder on
// pull, exactly like the other four hooks.
//
// WHAT IT DOES. At turn end it reads the agent's last assistant message and, if
// that message contains a bare "#NNN" that resolves to a REAL GDS task id (the
// classifier is linkify-refs.js's — same unit-tested rules, so a genuine
// "PR #8" is left alone), it returns {decision:"block", reason} to make the
// model re-emit those refs as clickable hall links before the turn can close.
//
// HONEST LIMITATION. A Stop hook fires AFTER the message has rendered, so it
// APPENDS a corrected version — it cannot un-404 the original line already in
// the user's scrollback. It is a backstop + a nudge, not a pre-filter. The
// clean fix is still the model getting it right the first time (the CLAUDE.md
// rule); this catches the slips.
//
// SAFETY POSTURE (a hook must NEVER break a turn):
//   • Any error / missing transcript / unreachable id list → exit 0 (allow stop).
//   • stop_hook_active === true → exit 0 (one forced re-emit max; no loops).
//   • No "#<digits>" in the message → exit 0 with zero network (the common case).
//   • The id allow-list is the token-free public endpoint, cached in TMP with a
//     TTL, fetched with a tight timeout — so most turns do no network at all.
//
// Wired in .claude/settings.json:  node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-refcheck.js"

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Reuse the doc-linkifier's classifier. require() is side-effect-free there
// (its main() is guarded by require.main===module). If it can't be loaded we
// fail open.
let linkifyText = null;
let RESOLVER_BASE = 'https://amazonprimea.com/builders#/task/';
try {
  const lib = require(path.resolve(__dirname, '..', '..', 'scripts', 'gds', 'linkify-refs.js'));
  linkifyText = lib.linkifyText;
  if (lib.RESOLVER_BASE) RESOLVER_BASE = lib.RESOLVER_BASE;
} catch (_) { /* fail-open in evaluate() */ }

const API_BASE = process.env.GDS_API_BASE || process.env.PMS_API_BASE || 'https://amazonprimea.com';
const TMP = process.platform === 'win32'
  ? (process.env.TEMP || process.env.TMP || require('node:os').tmpdir())
  : '/tmp';
const CACHE = path.join(TMP, 'otb-refids.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — task ids grow slowly; a just-created id simply isn't caught yet (fail-safe, not fail-wrong).
const FETCH_TIMEOUT_MS = 2500;

const REF_RE = /#\d{1,5}/;

function allowStop() { process.exit(0); } // the lone "let the turn end" exit.

// ---- pure decision core (unit-tested in tests/stop_refcheck.mjs) -----------

// Given the assistant's last message text and the Set of real task ids, decide
// whether to block. Pure: no I/O, no network. linkifyText does the classifying
// (task refs → would-linkify; entity refs like "blocker #5"/"migration #84" →
// would-neutralize; "PR #8" → skipped). Both linkify and neutralize represent a
// bare "#NNN" that 404s in chat, so either is an offender.
function evaluate(text, validIds) {
  const none = { block: false, reason: null, refs: [] };
  if (!text || !REF_RE.test(text)) return none;
  if (typeof linkifyText !== 'function' || !validIds || !validIds.size) return none;

  const stats = { linkified: 0, neutralized: 0, unlinked: 0, skipped: {} };
  try {
    linkifyText(text, validIds, stats);
  } catch (_) {
    return none; // classifier blew up on this input → don't block on a guess.
  }
  const offenders = (stats.linkified || 0) + (stats.neutralized || 0);
  if (!offenders) return none;

  const refs = [...new Set(text.match(/#\d{1,5}/g) || [])];
  return { block: true, reason: buildReason(refs, validIds), refs };
}

function buildReason(refs, validIds) {
  // Prefer a real-task id as the worked example, so the model sees the exact
  // shape it should emit.
  const sample = (refs.map((r) => r.slice(1)).find((n) => validIds.has(Number(n)))) || 'NNN';
  const shown = refs.slice(0, 6).join(', ');
  return (
    `Your last message used bare ${shown || '#NNN'} for GDS record(s). In the Claude app a bare "#NNN" ` +
    `autolinks to the dev-box GitHub remote (…/issues/NNN) and 404s — task numbers are NOT GitHub issue numbers. ` +
    `Re-send those references in clickable form before you finish:\n` +
    `  • a GDS task → a hall link that renders as a clean #N, e.g. [#${sample}](${RESOLVER_BASE}${sample})\n` +
    `  • a non-task record (idea / blocker / migration / report / session) → the number with NO "#", e.g. "migration ${sample}"\n` +
    `  • a genuine GitHub PR/issue (e.g. "PR #8") → leave it as-is.\n` +
    `You can post just the corrected references; no need to repeat the whole message.`
  );
}

// ---- I/O plumbing ----------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    // Insurance: never stall turn-end if stdin somehow never closes.
    setTimeout(() => resolve(data), 1500).unref();
  });
}

// The last assistant message's concatenated text blocks. Transcript is JSONL;
// entry shape mirrors ship.js buildSessionDigest: { type:'assistant',
// message:{ content:[ {type:'text', text}, … ] } }.
function lastAssistantText(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { continue; }
    if (e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      const txt = e.message.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (txt.trim()) return txt;
    }
  }
  return '';
}

function readCachedIds() {
  try {
    const st = fs.statSync(CACHE);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    const ids = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
  } catch (_) {
    return null;
  }
}

async function fetchIds() {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/gds/public/ref-ids`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'amazonprimea-gds-refcheck/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data.tasks || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return null;
    try { fs.writeFileSync(CACHE, JSON.stringify(ids)); } catch (_) { /* cache is best-effort */ }
    return new Set(ids);
  } catch (_) {
    return null; // timeout / offline / not-yet-deployed → fail open.
  } finally {
    clearTimeout(to);
  }
}

async function resolveIds() {
  // Offline / test override, mirroring linkify-refs.js --ids.
  if (process.env.OTB_REFIDS) {
    return new Set(
      String(process.env.OTB_REFIDS).split(',').map((s) => Number(s.trim())).filter(Number.isInteger)
    );
  }
  return readCachedIds() || (await fetchIds());
}

async function main() {
  let hook = {};
  try { hook = JSON.parse((await readStdin()) || '{}'); } catch (_) { hook = {}; }

  if (hook.stop_hook_active) allowStop();         // already forced one re-emit → never loop.

  const tp = hook.transcript_path;
  if (!tp || !fs.existsSync(tp)) allowStop();

  let text = '';
  try { text = lastAssistantText(tp); } catch (_) { allowStop(); }
  if (!text || !REF_RE.test(text)) allowStop();   // zero-overhead fast path: no refs → no network.

  const ids = await resolveIds();
  if (!ids || !ids.size) allowStop();             // no allow-list → fail open.

  const { block, reason } = evaluate(text, ids);
  if (!block) allowStop();

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0)); // any unexpected throw → allow the stop.
}

module.exports = { evaluate, buildReason, lastAssistantText, RESOLVER_BASE };
