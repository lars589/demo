#!/usr/bin/env node
// V3.R56 (#275) — Memory pull-on-session-start. The PULL half of ADR 0024's
// cloneable-memory chain (#273 storage, #274 push-on-ship, #276 read API are
// the foundation this builds on).
//
// On session start, ask the server what memory files this builder has stored
// (GET /api/gds/memory/files), compare each against the local memory dir, and
// write down any file the server has that is NEWER or that the local copy is
// missing/different. A fresh worktree (or a new machine) thus restores the
// builder's MEMORY.md + feedback_*.md automatically.
//
// ## Conflict policy (ADR 0024 §3 — last-write-wins, server clock authority)
//
// For each server file:
//   * If there is NO local file at that path  → pull (restore).
//   * If the local sha256 EQUALS the server sha256 → identical, skip (nothing
//     to do; cheap to detect and avoids a content fetch).
//   * If they DIFFER → pull ONLY when the server copy is newer than the local
//     file (server updated_at/mtime > local file mtime). If the LOCAL file is
//     newer, it's the builder's unsynced work — leave it; the next /builder-ship
//     pushes it up and reconciles. WHEN IN DOUBT (timestamps missing/equal), we
//     favor the LOCAL copy and skip, so a pull can never clobber local work.
//
// We never delete a local file that the server lacks — pull is additive/refresh
// only; deletion is out of scope and dangerous.
//
// ## Cost posture (load-bearing — runs on every session start)
//
// ONE list call (GET /memory/files) gives every server file's sha256 + byte_len
// + timestamps. We only GET /memory/file?path= for files we have actually
// decided to write (missing locally, or differ AND server-newer). No content is
// fetched for files we won't write. Zero LLM calls.
//
// ## Discipline (matches session-start.js / conductor.js)
//
// Best-effort, silent-failure: no session, API down, no server memory, a single
// bad path — none of these block session start. Every path either succeeds or
// degrades to a logged warning + continue. main() always resolves; session-start.js
// (which spawns this) and the `if (require.main)` guard both exit 0 regardless.
//
// ## Surface (exported for tests)
//
//   decidePull(serverFile, localStat) -> { action, reason }
//       Pure. The unit-tested core of the newer/changed decision.
//   safeJoin(memDir, relPath) -> absolute path INSIDE memDir, or null if the
//       path escapes (traversal defense — the #1 thing a reviewer attacks).
//   The plumbing (token read, fetch, fs writes) is thin and degradable.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const FETCH_TIMEOUT_MS = 4000;

// ---------- path safety (traversal defense on WRITE) ----------
//
// The server validates paths on write (memory.js assertValidPath), but the
// pull side writes to the LOCAL filesystem, so we MUST defend independently and
// not trust that a stored path is benign. Decode any percent-encoding FIRST
// (so %2e%2e/evil is caught), reject the obvious escape vectors, then resolve
// against memDir and assert the result stays strictly inside memDir. Returns
// the safe absolute path, or null to skip.
function safeDecode(p) {
  // decodeURIComponent can throw on malformed sequences (e.g. a lone '%'); a
  // throw here means "treat as unsafe" — return the raw string so the literal
  // checks below still run and most likely reject it.
  try {
    return decodeURIComponent(p);
  } catch (_) {
    return p;
  }
}

function safeJoin(memDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;

  // Decode BEFORE any check so URL-encoded traversal (%2e%2e, %2f) can't sneak
  // past the literal '..' / leading-'/' guards. Decode twice-over defensively
  // in case of double-encoding (%252e -> %2e -> .).
  let decoded = safeDecode(relPath);
  decoded = safeDecode(decoded);

  // Reject the structural escape vectors outright.
  if (
    decoded.length === 0 ||
    decoded.includes('\0') ||          // NUL
    decoded.includes('\\') ||          // backslash (Windows-style / smuggling)
    decoded.startsWith('/') ||         // absolute POSIX path
    /^[a-zA-Z]:/.test(decoded) ||      // Windows drive-absolute (C:\)
    decoded.split(/[/\\]/).includes('..') // any '..' segment
  ) {
    return null;
  }

  // Resolve against memDir and confirm containment. resolve() collapses any
  // residual '.'/'..' so even a path the literal checks missed can't escape.
  const memDirResolved = path.resolve(memDir);
  const abs = path.resolve(memDirResolved, decoded);
  // Must be strictly inside memDir: equal to it is not a file we'd write, and
  // anything outside is rejected. Use sep so '/memdir-evil' can't match '/memdir'.
  if (abs !== memDirResolved && !abs.startsWith(memDirResolved + path.sep)) {
    return null;
  }
  // Never write the dir itself.
  if (abs === memDirResolved) return null;
  return abs;
}

// ---------- pull decision (pure, unit-tested core) ----------
//
// serverFile: { path, sha256, byte_len, mtime, updated_at } from GET /memory/files.
// localStat:  null (no local file) OR { sha256, mtimeMs } of the local file.
// Returns { action: 'pull' | 'skip', reason }.
function decidePull(serverFile, localStat) {
  if (!localStat) {
    return { action: 'pull', reason: 'missing-locally' };
  }
  // Identical content — nothing to do, and crucially no content fetch needed.
  if (serverFile.sha256 && localStat.sha256 && serverFile.sha256 === localStat.sha256) {
    return { action: 'skip', reason: 'identical' };
  }
  // Content differs. Pull ONLY if the server copy is strictly newer than the
  // local file. The server's authority timestamp is updated_at (when the row
  // last changed); fall back to the stored mtime if updated_at is absent.
  const serverTs = tsToMs(serverFile.updated_at) ?? tsToMs(serverFile.mtime);
  const localTs = Number.isFinite(localStat.mtimeMs) ? localStat.mtimeMs : null;
  if (serverTs == null || localTs == null) {
    // Can't compare timestamps — favor the LOCAL copy (don't clobber unsynced
    // work). Last-write-wins degrades to local-wins when the clock is unknown.
    return { action: 'skip', reason: 'differ-but-timestamps-unknown-favor-local' };
  }
  if (serverTs > localTs) {
    return { action: 'pull', reason: 'server-newer' };
  }
  return { action: 'skip', reason: 'local-newer-or-equal' };
}

function tsToMs(ts) {
  if (ts == null) return null;
  if (ts instanceof Date) {
    const n = ts.getTime();
    return Number.isNaN(n) ? null : n;
  }
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const n = Date.parse(String(ts));
  return Number.isNaN(n) ? null : n;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- memory-dir resolution (mirrors scripts/gds/ship.js) ----------
//
// Claude Code stores per-project memory under
//   <homedir>/.claude/projects/<encoded-project-path>/memory/
// where <encoded-project-path> is the project's ABSOLUTE path with every '/'
// and '.' replaced by '-'. CLAUDE_CONFIG_DIR overrides the ~/.claude base. We
// key the memory dir to the MAIN worktree root (the canonical project
// checkout), NOT this ephemeral feature worktree — same convention ship.js
// uses for the push side, so push and pull address the same keyspace.
// NO hardcoded identity (CLAUDE.md §10): homedir via os.homedir().
function claudeConfigBase() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function encodeProjectPath(absProjectPath) {
  return absProjectPath.replace(/[/.]/g, '-');
}

function mainWorktreeRoot(startCwd) {
  // The first `worktree` line of the porcelain output is always the main
  // checkout. Matches session-start.js's env-provisioning approach.
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: startCwd, timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n').find((l) => l.startsWith('worktree '));
    if (first) return first.slice('worktree '.length).trim();
  } catch (_) { /* fall through */ }
  // Fallback: the toplevel of the current checkout.
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startCwd, timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function resolveMemoryDir(startCwd) {
  const root = mainWorktreeRoot(startCwd);
  if (!root) return null;
  const encoded = encodeProjectPath(path.resolve(root));
  return path.join(claudeConfigBase(), 'projects', encoded, 'memory');
}

// ---------- session token (mirrors conductor.js readSessionToken) ----------
function readSessionToken() {
  for (const name of ['gds-session.json', 'pms-session.json']) {
    try {
      const p = path.join(os.homedir(), '.config', 'otb', name);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.token) {
        return {
          token: j.token,
          apiBase: process.env.GDS_API_BASE || process.env.PMS_API_BASE || j.api_base || 'https://amazonprimea.com',
        };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

async function apiGet(apiBase, token, urlPath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}${urlPath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'amazonprimea-pull-memory-hook/1.0',
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Atomic-ish write: write to a temp file in the SAME dir (so rename is atomic
// on the same filesystem) then rename over the target. An interrupted pull can
// leave a stray .tmp but never a half-written memory file.
async function writeFileAtomic(absPath, content) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, content, { mode: 0o600 });
    await fsp.rename(tmp, absPath);
  } catch (err) {
    // Clean up the temp on failure; swallow cleanup errors.
    try { await fsp.unlink(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

// Stat a local file into { sha256, mtimeMs } or null if absent/unreadable.
async function localStatOf(absPath) {
  try {
    const st = await fsp.stat(absPath);
    if (!st.isFile()) return null;
    const buf = await fsp.readFile(absPath);
    return { sha256: sha256Hex(buf), mtimeMs: st.mtimeMs };
  } catch (_) {
    return null;
  }
}

// ---------- the pull run (best-effort; returns a summary string) ----------
async function pullMemory({ startCwd } = {}) {
  const cwd = startCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const sess = readSessionToken();
  if (!sess) return null; // no session → silent no-op (newcomer / not set up)

  const memDir = resolveMemoryDir(cwd);
  if (!memDir) return null; // not a git checkout we can key memory to

  let list;
  try {
    list = await apiGet(sess.apiBase, sess.token, '/api/gds/memory/files');
  } catch (_) {
    return '[otb] memory pull: skipped (server unreachable).';
  }
  if (!list || !list.ok) {
    // 401 (session not valid for this), 5xx, etc. — non-blocking.
    return null;
  }
  const files = Array.isArray(list.data?.files) ? list.data.files : [];
  if (files.length === 0) {
    return null; // nothing stored server-side — normal for a builder with no memory
  }

  let pulled = 0;
  let skipped = 0;
  let rejected = 0;
  let failed = 0;

  // ---- DECIDE phase: which files need pulling? (no network here) ----
  // Resolve each server file to a safe local path, stat the local copy, and run
  // the pure last-write-wins decision. We do this for ALL files first so the
  // content fetches that follow can run concurrently rather than serially.
  const toFetch = []; // [{ sf, abs }]
  for (const sf of files) {
    if (!sf || typeof sf.path !== 'string') { rejected += 1; continue; }

    // TRAVERSAL DEFENSE: resolve to a safe absolute path inside memDir or skip.
    const abs = safeJoin(memDir, sf.path);
    if (!abs) { rejected += 1; continue; }

    // INTEGRITY (mandatory): we will never write content we can't verify. A
    // server file entry with no sha256 is unverifiable, so reject it up front —
    // before spending a content fetch on it.
    if (typeof sf.sha256 !== 'string' || sf.sha256.length === 0) {
      rejected += 1;
      continue;
    }

    const local = await localStatOf(abs);
    const { action } = decidePull(sf, local);
    if (action !== 'pull') { skipped += 1; continue; }

    toFetch.push({ sf, abs });
  }

  // ---- FETCH + WRITE phase: bounded-concurrency content pulls ----
  // Each entry: fetch the content, verify sha256 MANDATORILY, then write
  // atomically. A rejected/failed entry must not abort its siblings, so every
  // unit is wrapped and Promise.allSettled never rejects. Concurrency is capped
  // so a cold start pulling many files can't open a socket per file at once.
  const CONCURRENCY = 8;
  async function fetchVerifyWrite({ sf, abs }) {
    let fileRes;
    try {
      fileRes = await apiGet(sess.apiBase, sess.token, `/api/gds/memory/file?path=${encodeURIComponent(sf.path)}`);
    } catch (_) {
      return 'failed';
    }
    if (!fileRes || !fileRes.ok || !fileRes.data || typeof fileRes.data.content !== 'string') {
      return 'failed';
    }

    // Integrity is MANDATORY: the fetched content's computed sha256 must match
    // the expected sha256 from the list. A mismatch (corrupted/tampered
    // transfer) means we DO NOT write it — count as rejected and warn. Same
    // algorithm/encoding as the server (sha256 hex of the UTF-8 bytes) so a
    // good transfer never false-negatives.
    const content = fileRes.data.content;
    const got = sha256Hex(Buffer.from(content, 'utf8'));
    if (got !== sf.sha256) {
      process.stderr.write(`[otb] memory pull: integrity check failed for ${sf.path} — skipped (not written).\n`);
      return 'rejected';
    }

    try {
      await writeFileAtomic(abs, content);
      // Mirror the server's mtime onto the restored file so a subsequent pull
      // sees them as equal (idempotent) rather than re-pulling forever.
      const serverMs = tsToMs(fileRes.data.mtime) ?? tsToMs(sf.mtime) ?? tsToMs(sf.updated_at);
      if (serverMs != null) {
        const when = new Date(serverMs);
        try { await fsp.utimes(abs, when, when); } catch (_) { /* mtime is advisory */ }
      }
      return 'pulled';
    } catch (_) {
      return 'failed';
    }
  }

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const chunk = toFetch.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(fetchVerifyWrite));
    for (const r of settled) {
      // fetchVerifyWrite never throws, but allSettled is belt-and-braces: a
      // rejected promise counts as a failed file, not an aborted run.
      const outcome = r.status === 'fulfilled' ? r.value : 'failed';
      if (outcome === 'pulled') pulled += 1;
      else if (outcome === 'rejected') rejected += 1;
      else failed += 1;
    }
  }

  // ---- summary ----
  if (pulled === 0 && rejected === 0 && failed === 0) {
    return '[otb] memory: up to date.';
  }
  if (pulled === 0) {
    // The pull RAN — it just didn't write anything. Lead with that so the line
    // doesn't read like the pull itself failed.
    const bits = [];
    if (rejected) bits.push(`${rejected} skipped`);
    if (failed) bits.push(`${failed} failed`);
    if (skipped) bits.push(`${skipped} already current`);
    return `[otb] memory pull: 0 written${bits.length ? `, ${bits.join(', ')}` : ''}.`;
  }
  const bits = [`pulled ${pulled} memory file${pulled === 1 ? '' : 's'} from the server`];
  if (skipped) bits.push(`${skipped} already current`);
  if (rejected) bits.push(`${rejected} skipped`);
  if (failed) bits.push(`${failed} failed`);
  return `[otb] memory: ${bits.join(', ')}.`;
}

// Map hygiene (task 1362): after the pull, keep MEMORY.md — the index the harness
// loads IN FULL every session — light. WARN when it's over the soft budget;
// AUTO-TIDY when it crosses the hard threshold by demoting the oldest non-rule
// entries to the "drawer" (their topic files stay on disk + server + /recall — only
// the index line is removed; standing rules + pinned entries are never demoted).
// All real logic lives in the tested scripts/gds/memory-map.js. The write is
// parallel-safe: skipped if another concurrent session changed the file meanwhile.
async function mapHygiene(startCwd) {
  try {
    const dir = resolveMemoryDir(startCwd);
    if (!dir) return null;
    const mm = require(path.join(__dirname, '..', '..', 'scripts', 'gds', 'memory-map.js'));
    const mapPath = path.join(dir, 'MEMORY.md');
    let text;
    try { text = await fsp.readFile(mapPath, 'utf8'); } catch { return null; }
    const m = mm.measure(text);
    if (m.overTidy) {
      const plan = mm.planCompaction(text, { memoryDir: dir });
      if (plan.willChange) {
        const r = mm.applyCompaction(mapPath, text, plan.newText);
        if (r.written) {
          const now = mm.measure(plan.newText);
          const n = plan.demote.length;
          return `[otb] memory map: auto-tidied — demoted ${n} stale entr${n === 1 ? 'y' : 'ies'} to the drawer (still saved + /recall-able); map now ~${now.tokens} tok / ${now.count} entries.`;
        }
        return `[otb] memory map: over budget (~${m.tokens} tok) — auto-tidy deferred (the file changed mid-session); it'll tidy next session.`;
      }
    }
    if (m.overWarn || m.longLines.length) {
      const reasons = [];
      if (m.overWarn) reasons.push(`over the ~${mm.estTokens(mm.WARN_BYTES)}-token soft budget`);
      if (m.longLines.length) reasons.push(`${m.longLines.length} over-long index line${m.longLines.length === 1 ? '' : 's'}`);
      return `[otb] memory map: ~${m.tokens} tok / ${m.count} entries — ${reasons.join(' · ')}; consider a compaction pass.`;
    }
    return null;
  } catch (_) {
    return null; // never break session start
  }
}

async function main() {
  try {
    const summary = await pullMemory({});
    if (summary) process.stdout.write(summary + '\n');
  } catch (_) {
    // Absolutely nothing here may break session start.
  }
  try {
    const hygiene = await mapHygiene();
    if (hygiene) process.stdout.write(hygiene + '\n');
  } catch (_) {
    // Map hygiene is best-effort; never break session start.
  }
}

if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0));
}

module.exports = {
  mapHygiene,
  decidePull,
  safeJoin,
  tsToMs,
  resolveMemoryDir,
  encodeProjectPath,
  pullMemory,
};
