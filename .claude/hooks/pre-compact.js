#!/usr/bin/env node
// .claude/hooks/pre-compact.js — System 2 (task 1349). The thin PreCompact-seam
// reader around the pure eviction classifier (eviction-policy.js, task 1348).
//
// WHAT. At the PreCompact boundary — already a cache-reset point that pays one
// cache-write anyway — read the transcript, classify the stale tool output, and
// emit an eviction DIRECTIVE (which blocks to drop + one-line recovery stubs) as
// compaction guidance. Batching at PreCompact (NOT per-turn) is essential:
// rewriting the prefix every turn would invalidate the prompt cache and cost more
// than it saves. Recovery is retrieval-first — every stub points at /recall or a
// re-Read (task 1350).
//
// FLAGGED OFF BY DEFAULT. Runs only when OTB_INSESSION_COMPACT=1. Unset/anything
// else → instant no-op (the default for every builder). "Wire, don't arm."
//
// DEGRADE. If the harness build lacks a PreCompact event, the PreCompact stanza
// simply never fires. A builder on such a build can instead register this script
// as a Stop hook; invoked with a non-PreCompact event it emits an *advisory only*
// (stderr, never blocks) — it never rewrites context per-turn.
//
// CONTRACT: best-effort, NON-FATAL. Exits 0 on every path; a hook must never
// stall or break the session. Mirrors session-cost.js (watchdog + quiet skip).

'use strict';

const fs = require('fs');
const path = require('path');
const { classifyEviction } = require('./eviction-policy');

const FLAG = 'OTB_INSESSION_COMPACT';
const MAX_DIRECTIVE_STUBS = 30; // cap injected stubs so the directive itself stays cheap

// Pure: decide whether/how to run, from the env flag + the hook event name.
//   off            — flag not set to '1'
//   precompact     — the real batched path
//   stop-advisory  — fallback for harness builds without PreCompact (advisory only)
function gateDecision(env, hookEvent) {
  if ((env && env[FLAG]) !== '1') return { run: false, mode: 'off' };
  const isPreCompact = hookEvent === 'PreCompact';
  return { run: true, mode: isPreCompact ? 'precompact' : 'stop-advisory' };
}

// Pure: format the eviction directive injected as compaction guidance. Bounded —
// lists the biggest evictions, summarizes the rest, and always states the
// retrieval-first recovery rule once (prevents re-fetch loops, task 1350).
function buildDirective(classification, { maxStubs = MAX_DIRECTIVE_STUBS } = {}) {
  const { evict, stubs, summary } = classification;
  if (!evict || !evict.length) return '';
  const top = [...evict].sort((a, b) => b.tokens - a.tokens).slice(0, maxStubs);
  const lines = [];
  lines.push(
    `In-session compaction (System 2): ${summary.evict_blocks} stale tool outputs ` +
    `(~${summary.evict_tokens} tok, ${summary.evict_pct}% of tool output) are safe to drop. ` +
    `When compacting, REPLACE each listed tool_result with its stub and keep everything else verbatim. ` +
    `Recover any dropped content on demand via /recall or by re-Reading the file — do NOT pre-fetch.`
  );
  lines.push(`by reason: superseded ${summary.by_reason.superseded} tok · duplicate ${summary.by_reason.duplicate} tok · stale_dump ${summary.by_reason.stale_dump} tok`);
  for (const e of top) lines.push(`  • ${stubs[e.tool_use_id]}`);
  if (evict.length > top.length) lines.push(`  • …and ${evict.length - top.length} more smaller blocks (same rules).`);
  return lines.join('\n');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data || null));
    setTimeout(() => resolve(data || null), 400);
  });
}

function loadTranscript(tp) {
  const raw = fs.readFileSync(tp, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

async function main() {
  const watchdog = setTimeout(() => process.exit(0), 6000);
  watchdog.unref();
  try {
    let hook = {};
    try { hook = JSON.parse((await readStdin()) || '{}'); } catch (_) { hook = {}; }

    const decision = gateDecision(process.env, hook.hook_event_name);
    if (!decision.run) process.exit(0); // flag off → silent no-op (the default)

    const tp = hook.transcript_path;
    if (!tp || !fs.existsSync(tp)) process.exit(0);

    let transcript;
    try { transcript = loadTranscript(tp); } catch (_) { process.exit(0); }

    const classification = classifyEviction(transcript);
    const directive = buildDirective(classification);
    if (!directive) process.exit(0); // nothing stale → no-op

    const s = classification.summary;
    if (decision.mode === 'stop-advisory') {
      // Fallback for builds without PreCompact: advisory only, never blocks.
      console.error(`[pre-compact] (advisory) ${s.evict_blocks} stale tool outputs ~${s.evict_tokens} tok (${s.evict_pct}%) could be evicted at the next compaction.`);
      process.exit(0);
    }

    // PreCompact: emit the directive as compaction guidance (best-effort — an
    // older harness that ignores hookSpecificOutput simply compacts as usual).
    console.error(`[pre-compact] System 2: directing eviction of ${s.evict_blocks} stale tool outputs ~${s.evict_tokens} tok (${s.evict_pct}% of tool output).`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: directive },
    }));
    process.exit(0);
  } catch (err) {
    console.error('pre-compact: skipped (non-fatal):', err && err.message ? err.message : err);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { gateDecision, buildDirective, FLAG, MAX_DIRECTIVE_STUBS };
