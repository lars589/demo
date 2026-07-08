#!/usr/bin/env node
// Cross-platform port of rank-change-greeting.sh (#671) — the promotion/
// demotion ceremony (V3.R28 #249).
//
// When a builder's rank changed since this hook last announced it, print the
// greeting (SessionStart stdout flows into Claude's session context) and
// remember we did, so it fires exactly once per change. Pure node (was
// bash + curl + inline-node parsing) so it behaves identically on Windows,
// macOS, and Linux. Invoked by session-start.js; also runnable by hand:
//   node .claude/hooks/rank-change-greeting.js
//
// Idempotency marker at ~/.config/cloudbongos/rank-change-seen.json, one record per
// builder_id so multiple identities on one machine don't clobber each other.
//
// Silent-failure discipline (matches the bash original): no session, network
// down, malformed payload, or already-greeted → exit 0 with nothing. Never
// blocks session start.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let API_BASE = 'https://demo.cloudbongos.com';
let loadSessionSync = null;
try {
  ({ API_BASE, loadSessionSync } = require('../../scripts/gds/cli-lib'));
} catch (_) {
  // cli-lib unavailable → nothing we can resolve; the main() guard no-ops.
}

const SEEN_FILE = path.join(os.homedir(), '.config', 'otb', 'rank-change-seen.json');

// Fetch the pending rank-change row. 8s overall budget (the bash used curl
// --connect-timeout 6 --max-time 8) so session start never feels slow on a
// flaky network. Any error → null (silent no-op).
async function fetchPendingChange(apiBase, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${apiBase}/api/gds/builders/me/pending-rank-change`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'amazonprimea-rank-change-hook/1.0',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeSeen(obj) {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  } catch (_) {
    /* best-effort */
  }
}

async function main() {
  if (typeof loadSessionSync !== 'function') return;
  const sess = loadSessionSync();
  if (!sess || !sess.token) return; // no session → silent no-op (newcomer / not set up)

  // Base resolution mirrors pull-memory.js / conductor.js: explicit env
  // override first, then the base stored in the session file (api_base —
  // snake_case is the on-disk field), then the production default that
  // cli-lib's API_BASE already resolves to.
  const apiBase = process.env.GDS_API_BASE || process.env.PMS_API_BASE || sess.api_base || API_BASE;
  const payload = await fetchPendingChange(apiBase, sess.token);
  const change = payload && payload.change;
  const greeting = payload && payload.greeting;
  if (!change || change.id == null || !greeting) return; // no pending change

  // builderId is a DB integer in practice, but it arrives from a JSON response
  // and is interpolated into a filename below — sanitize to a safe charset so a
  // compromised/MITM'd server response can never path-traverse the temp-file
  // write (e.g. "../../.bashrc"). Belt-and-braces; the endpoint is HTTPS + auth.
  const rawBuilderId = change.builder_id == null ? '' : String(change.builder_id);
  const builderId = rawBuilderId.replace(/[^0-9A-Za-z_-]/g, '_');
  const changeId = String(change.id);
  if (!builderId) return;

  // Have we already greeted on this change? Per-builder marker.
  const seen = readSeen();
  if (String(seen[builderId] || '') === changeId) return;

  // Surface the greeting to Claude (SessionStart stdout → session context).
  console.log(`[cloudbongos] ${greeting}`);

  // Transient file too — inspectable; per-builder name keeps multi-identity tidy.
  try {
    const tmpDir = process.env.TMPDIR || os.tmpdir();
    fs.writeFileSync(path.join(tmpDir, `otb-rank-change-greeting-${builderId}`), greeting + '\n');
  } catch (_) {
    /* best-effort */
  }

  // Persist the "seen" marker so we don't re-greet next session.
  seen[builderId] = changeId;
  writeSeen(seen);
}

// Entry-point only — invoked by session-start.js as a child process (or by
// hand). Not a library, so nothing is exported (cf. conductor.js/pull-memory.js
// which export pure functions specifically because tests cover them).
if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0));
}
