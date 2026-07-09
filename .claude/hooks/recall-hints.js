#!/usr/bin/env node
// SessionStart recall hints (#963 / V4.R25 — criterion sessions-start-knowing).
//
// When a session opens HOLDING an active claim, surface the top project-knowledge
// hits for that task (POST /api/gds/search — the rank/owner-scoped lexical recall
// layer from ADR 0060) so the agent starts already pointed at the relevant ADRs /
// recipes / session-logs / learnings, instead of re-discovering them mid-session.
// This is the claim-time recall surface promised in the V4.R04 context pack,
// arriving at session start for a RESUMED claim.
//
// Contract (mirrors the memory pull in session-start.js):
//   - best-effort + SILENT on any failure (no token, network error, empty, slow);
//   - kill-switched: never inside a grader subagent (CLOUDBONGOS_SUBAGENT) or when
//     explicitly disabled (CLOUDBONGOS_RECALL_HINTS_OFF);
//   - HARD <2s budget — a single shared deadline aborts the network calls so it
//     can never noticeably delay session start.
//
// Uses readSessionToken() + raw fetch (NOT cli-lib apiCall, which prints guidance
// and exits the process on 401) — the same fail-open pattern the sound player uses.

const path = require('node:path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

// Total wall-clock budget for the whole hint fetch. Kept comfortably under the
// 2s session-start ceiling; the two network calls share it.
const DEADLINE_MS = 1800;
const HINT_LIMIT = 3;

// ---- pure helpers (exported for tests) -------------------------------------

// Strip the decorative "V4.R25 — " rank prefix and a trailing "(…)" aside from a
// task title so the search query is the substantive phrase, not planning chrome.
// e.g. "V4.R25 — Session-start recall hints (kill-switched, like the memory pull)"
//   →  "Session-start recall hints"
function taskQuery(title) {
  let t = String(title || '').trim();
  t = t.replace(/^[A-Za-z0-9.]+\s*[—-]\s*/, ''); // leading "V4.R25 — " / "R25 - "
  t = t.replace(/\s*\([^)]*\)\s*$/, '');          // trailing parenthetical aside
  return t.trim() || String(title || '').trim();
}

// Pick the claim a resumed session most likely cares about: the most recently
// claimed one. Returns null when there are no active claims. (A SessionStart hook
// can't know which terminal maps to which claim; latest-claim is the best signal
// and matches how a builder resumes the thing they were last working on.)
function pickActiveClaim(meBody) {
  const claims = (meBody && (meBody.active_claims || (meBody.active_claim ? [meBody.active_claim] : []))) || [];
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const withTime = claims.filter((c) => c && c.task_id != null);
  if (withTime.length === 0) return null;
  withTime.sort((a, b) => {
    const ta = a.claimed_at ? Date.parse(a.claimed_at) : 0;
    const tb = b.claimed_at ? Date.parse(b.claimed_at) : 0;
    return tb - ta; // newest first
  });
  return withTime[0];
}

// Render the hint block. Returns null when there's nothing worth printing (so the
// caller stays silent). `claim` is {task_id, title}; `results` is the search rows.
// The claimed task's OWN indexed chunk (source_ref `task:<id>`) is dropped — the
// agent already holds its own task; echoing it back is noise.
function formatHints(claim, results) {
  if (!claim) return null;
  const selfRef = `task:${claim.task_id}`;
  const rows = (Array.isArray(results) ? results : [])
    .filter((r) => r && r.source_ref !== selfRef)
    .slice(0, HINT_LIMIT);
  if (rows.length === 0) return null;
  const lines = [];
  lines.push(`[cloudbongos] 🔎 Recall hints for your active claim #${claim.task_id}:`);
  for (const r of rows) {
    const where = r.heading_path || r.source_ref || '';
    const title = r.title || r.source_ref || '(untitled)';
    lines.push(`  • ${title}${where ? `  — ${where}` : ''}`);
  }
  lines.push('  (rank-scoped; run /recall <query> to dig further)');
  return lines.join('\n');
}

// ---- network (raw fetch, fail-open) ----------------------------------------

async function fetchJson(method, url, token, body, signal) {
  const headers = { 'User-Agent': 'cloud-bongos-gds-cli/1.0' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null, signal });
  if (!res.ok) return null;
  return res.json();
}

async function main() {
  if (process.env.CLOUDBONGOS_SUBAGENT || process.env.CLOUDBONGOS_RECALL_HINTS_OFF) return;

  // Read the session token directly; no token → silent no-op (fresh box / signed out).
  let session;
  try {
    ({ readSessionToken: session } = require(path.join(PROJECT_DIR, 'scripts', 'gds', 'cli-lib')));
  } catch (_) { return; }
  const tok = typeof session === 'function' ? session() : null;
  if (!tok || !tok.token) return;
  const base = tok.apiBase;

  // One shared deadline across both calls.
  const signal = AbortSignal.timeout(DEADLINE_MS);

  let claim = null;
  let results = null;
  try {
    const me = await fetchJson('GET', `${base}/api/gds/me`, tok.token, null, signal);
    claim = pickActiveClaim(me);
    if (!claim) return; // session opened without an active claim → nothing to hint
    const q = taskQuery(claim.title);
    if (!q) return;
    // Over-fetch a little so dropping the task's own self-match still leaves a
    // full set of HINT_LIMIT real hits.
    const search = await fetchJson('POST', `${base}/api/gds/search`, tok.token, { q, limit: HINT_LIMIT + 2 }, signal);
    results = search && search.results;
  } catch (_) {
    return; // timeout / network / parse — silent
  }

  const block = formatHints(claim, results);
  if (block) console.log(block);
}

if (require.main === module) {
  main().catch(() => { /* never surface */ }).finally(() => process.exit(0));
}

module.exports = { taskQuery, pickActiveClaim, formatHints, DEADLINE_MS, HINT_LIMIT };
