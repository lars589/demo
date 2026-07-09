#!/usr/bin/env node
// MAS — the Conductor. Shipped advisory in Phase 3 (#427); gained
// session-mediated dispatch in Phase 4 (#439).
//
// A UserPromptSubmit hook: on every builder prompt, look at what's changing
// in the working tree + what the prompt intends + the active GDS claim, and
// emit advisory nudges ("you probably want to bring in X"). Phase 4: a
// security-sensitive change upgrades the nudge into a DISPATCH DIRECTIVE — the
// emitted text tells the SESSION to run `conductor-dispatch.js hacker` and
// surface findings. The hook itself still SPAWNS NOTHING and blocks NOTHING; it
// proposes, the session disposes ("Conductor proposes, never disposes"). It
// runs as the builder, so it grants no new authority (ADR 0016 stays intact).
//
// ## Cost posture (load-bearing)
//
// ZERO LLM calls IN THE HOOK. This runs on every prompt, so any model call here
// would tax latency + the $5K budget on every turn. Everything here is local
// git + prompt regex + a cached, timeout-bounded, read-only GET /api/gds/me.
// The actual specialist review (a Sonnet subagent) only runs when the SESSION
// executes the dispatch directive — visible + interruptible, never from the
// hook itself. Autonomous background dispatch (Phase 4.5) lives OUTSIDE this
// per-prompt hook entirely — `conductor-dispatch.js auto-dispatch` selects
// claimable work without a prompt, gated by the $0 autonomy-gate precheck
// (INERT until CLOUDBONGOS_AUTONOMY_ENABLED=1). The hook stays prompt-driven + zero-LLM.
//
// ## Discipline (matches .claude/hooks/rank-change-greeting.js)
//
// Silent-failure: any missing session / network blip / parse error / git
// failure → exit 0 with no output. A hook must never break a prompt. Every
// code path below exits 0; the only thing that ever reaches stdout is the
// advisory block, which Claude Code injects as context for the main session.
//
// ## Surface
//
//   evaluateTriggers({ changedFiles, prompt, activeClaims, wandering }) -> advisory[]
//       Pure. The unit-tested core. `activeClaims`:
//         null  → claim state unknown (offline / no session) — skip claim-aware triggers
//         []    → definitively no active claim
//         [...] → claims, each { task_id, title, touches: [...] }
//       `wandering`: the resolved knob { effective_level, inject, contract } or
//         null (task 1268). When inject is true the contract is emitted as a
//         standing focus advisory; null / inject:false → no wandering advisory.
//
//   (the rest — stdin parse, git, cached fetch, emit — is thin plumbing)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
// Single source of truth shared with scripts/gds/conductor-dispatch.js — see
// src/bongos/sensitive-surfaces.js (the Phase 4 dogfood flagged the prior
// hand-copied duplication as a drift risk).
const { SENSITIVE_SURFACES, isSensitive } = require('../../src/bongos/sensitive-surfaces');
// Canonical path-coverage matcher. Relocated to src/bongos/path-match.js when the
// drift scanner was deleted (touches[] cleanup [4/8], task 879); routing through
// the one matcher kills the hand-rolled duplication the panel flagged on #439.
const { matchOne } = require('../../src/bongos/path-match');

const CACHE_PATH = path.join(os.homedir(), '.config', 'otb', 'conductor-cache.json');
const CLAIM_TTL_MS = 90_000; // re-fetch /me at most once per 90s
const FETCH_TIMEOUT_MS = 2500;

// ---------- pure trigger core (exported for tests) ----------

// Index / framing docs whose claims can drift from reality — the BFG's beat.
const INDEX_DOCS = new Set([
  'CLAUDE.md',
  'docs/architecture.md',
  'docs/file-map.md',
  'docs/canonical-permissions.md',
]);

const SHIP_INTENT_RE = /\/builder-ship\b|\bship it\b|\bi'?m done\b|\bmark (?:this )?complete\b/i;

// A prompt asking about project/criterion/version status. Kept deliberately
// vocabulary-gated (status / progress / remaining / left / "is X done") so it
// doesn't fire on every question. The point: route status questions to the
// one-call /status rollup (#435) instead of letting the session hand-assemble
// the answer from ~10 GDS calls.
const STATUS_INTENT_RE = /\bwhat'?s (?:left|remaining)\b|\bwhat (?:tasks?|work|criteria|criterion) (?:are|is|remain|still)\b|\b(?:status|progress) of\b|\bhow far along\b|\bwhat'?s the status\b|\bremaining to (?:complete|finish|satisfy)\b|\bis\s+[\w.-]+\s+(?:done|complete|finished|shipped|satisfied)\b/i;
// A "Cn" criterion token in the prompt → pass it through to /status C<n>.
const CRITERION_TOKEN_RE = /\bC(\d+)\b/;

// A changed file is "covered" by a claim's touches[] if the canonical path
// matcher (path-match.matchOne) says some entry covers it. Thin boolean
// wrapper so the export keeps its name + semantics; the matching logic lives in
// exactly one place (the same one the ship-time gate uses). Empty/absent
// touches → nothing is covered (everything reads as "outside" — the right nudge).
function isCovered(file, touches) {
  if (!Array.isArray(touches) || touches.length === 0) return false;
  return matchOne(file, touches) !== null;
}

function matchSensitive(changedFiles) {
  const hits = new Set();
  for (const f of changedFiles) {
    for (const s of SENSITIVE_SURFACES) {
      if (s.re.test(f)) hits.add(s.label);
    }
  }
  return [...hits];
}

// The actual changed files that sit on a security surface — used as the
// dispatch fingerprint so the Hacker re-dispatches when a NEW sensitive file
// enters the change set, not merely when the same set stays touched.
function sensitiveFiles(changedFiles) {
  return (changedFiles || []).filter((f) => isSensitive(f));
}

// Returns an ordered list of advisories: { id, icon, text }. `id` feeds the
// per-session dedupe fingerprint. Order = priority (methodology first).
function evaluateTriggers({ changedFiles = [], prompt = '', activeClaims = null, wandering = null, interaction = null } = {}) {
  const out = [];
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const hasCodeChanges = files.length > 0;
  const claimsKnown = Array.isArray(activeClaims);

  // 1. Hard methodology rule (the project-manager function): changes with no
  //    claim. Only fire when we DEFINITIVELY know there's no claim.
  if (claimsKnown && activeClaims.length === 0 && hasCodeChanges) {
    out.push({
      id: 'no-claim',
      icon: '⚠',
      text: `No active GDS claim, but the working tree has ${files.length} changed file(s). Per CLAUDE.md every change needs a claimed task. → /builder-start or /builder-claim N before going further.`,
    });
  }

  // 2. Changes outside the claim's declared touches[]. Only when we have at
  //    least one claim with touches and there's a definite footprint.
  if (claimsKnown && activeClaims.length > 0 && hasCodeChanges) {
    const allTouches = activeClaims.flatMap((c) => (Array.isArray(c.touches) ? c.touches : []));
    const outside = files.filter((f) => !isCovered(f, allTouches));
    // Only nudge if SOME files are covered (i.e. there's a real touches[] to
    // compare against) — if touches[] is empty across all claims we'd flag
    // everything, which is noise on a freshly-created task.
    if (outside.length > 0 && allTouches.length > 0) {
      const shown = outside.slice(0, 5).join(', ');
      const more = outside.length > 5 ? ` (+${outside.length - 5} more)` : '';
      out.push({
        id: 'outside-touches',
        icon: '⚠',
        text: `${outside.length} changed file(s) outside your claim's declared touches[]: ${shown}${more}. Heads-up only — touches[] is advisory; ship proceeds (the grader reads the real diff). Release if this work is genuinely out of scope.`,
      });
    }
  }

  // 3. Sensitive surface touched → DISPATCH the Hacker (Phase 4 #439). This
  //    advisory carries `dispatch` metadata; the main loop turns it into an
  //    actionable directive (run conductor-dispatch.js hacker) debounced on the
  //    sensitive-file set so it fires once per novel security change.
  const sensitive = matchSensitive(files);
  if (sensitive.length > 0) {
    const sfiles = sensitiveFiles(files);
    out.push({
      id: 'sensitive-surface',
      icon: '•',
      text: `Security-relevant surface touched (${sensitive.join(', ')}).`,
      dispatch: {
        specialist: 'hacker',
        files: sfiles,
        command: 'node scripts/gds/conductor-dispatch.js hacker',
      },
    });
  }

  // 4. Index / framing docs touched → keep the index honest (Phase 6: BFG,
  //    not yet built — stays advisory).
  const docHits = files.filter((f) => INDEX_DOCS.has(f));
  if (docHits.length > 0) {
    out.push({
      id: 'index-doc-edit',
      icon: '•',
      text: `Index/framing doc(s) touched (${docHits.join(', ')}). Verify any claims you change still match the DB / code reality — keep the index honest. [Phase 6: the BFG will own this once built.]`,
    });
  }

  // 5. Ship intent → remind about the panel + touches[].
  if (SHIP_INTENT_RE.test(prompt)) {
    out.push({
      id: 'ship-intent',
      icon: '•',
      text: `Ship intent detected. The 4-worker grader panel (Narc · Quality · Hacker · Efficiency Monger) will grade the diff — make sure touches[] reflects everything you changed first.`,
    });
  }

  // 6. Status-intent prompt → point at the one-call /status rollup (#435)
  //    instead of hand-assembling the answer from the GDS. Pure regex, no model
  //    call — preserves the per-prompt cost posture. Proposes, never disposes.
  if (STATUS_INTENT_RE.test(prompt)) {
    const cm = CRITERION_TOKEN_RE.exec(prompt);
    const arg = cm ? ` C${cm[1]}` : '';
    out.push({
      id: 'status-intent',
      icon: '•',
      text: `Looks like a project-status question. \`/status${arg}\` answers it in one call (criteria → gating tasks → what's left) instead of hand-querying the GDS.`,
    });
  }

  // 7. Wandering knob (task 1268). A standing focus contract for the
  //    CONSTRAINING levels only (Locked/Focused → inject:true). It keeps the
  //    agent from opening off-task threads — tangents, anomaly investigations,
  //    unsolicited suggestions — while leaving in-task initiative untouched.
  //    The level is resolved + clamped by rank server-side (wandering-prefs.js);
  //    this hook only relays the contract. Permissive levels (Balanced/
  //    Exploratory) set inject:false → nothing emitted, no context spent where
  //    the default behavior already aligns. Lowest priority; the per-session
  //    dedupe shows it ~once unless the advisory set changes.
  if (wandering && wandering.inject && typeof wandering.contract === 'string' && wandering.contract) {
    out.push({ id: 'wandering', icon: '🧭', text: wandering.contract });
  }

  // 8. Interaction profile (task 2010). A standing "how to pitch replies to THIS
  //    builder" contract — tone / technical level / toolchain familiarity —
  //    injected only when the builder is off the portable defaults (inject:false
  //    otherwise, so an all-default builder spends no context). Resolved
  //    server-side (interaction-prefs.js); this hook only relays the contract.
  if (interaction && interaction.inject && typeof interaction.contract === 'string' && interaction.contract) {
    out.push({ id: 'interaction', icon: '🗣️', text: interaction.contract });
  }

  return out;
}

// Fingerprint of the advisory SET (ids) — gates the general per-session dedupe.
function fingerprint(advisories) {
  return advisories.map((a) => a.id).sort().join(',');
}

// Fingerprint of the DISPATCH (sorted sensitive-file set) — gates whether the
// Hacker dispatch directive re-fires. Empty when nothing dispatchable.
function dispatchFingerprint(advisories) {
  const d = advisories.find((a) => a.dispatch);
  if (!d) return '';
  return (d.dispatch.files || []).slice().sort().join(',');
}

// Render the advisory block. opts.showDispatch=true turns the dispatchable
// advisory into an actionable directive (Phase 4); false renders the milder
// "already reviewed this surface" form (it was dispatched earlier this
// session and the surface hasn't changed since).
function render(advisories, opts = {}) {
  const showDispatch = !!opts.showDispatch;
  const lines = ['[cloudbongos] 🎼 Conductor:'];
  for (const a of advisories) {
    if (a.dispatch) {
      if (showDispatch) {
        lines.push(`  🚨 DISPATCH — ${a.text} Bringing in the ${a.dispatch.specialist}.`);
        lines.push(`     → run \`${a.dispatch.command}\` now and surface the findings before continuing.`);
      } else {
        lines.push(`  ${a.icon} ${a.text} Already reviewed by the ${a.dispatch.specialist} this session — re-run \`${a.dispatch.command}\` if you've changed it since.`);
      }
    } else {
      lines.push(`  ${a.icon} ${a.text}`);
    }
  }
  return lines.join('\n');
}

// ---------- plumbing (each step degrades to a safe default) ----------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parsePayload(raw) {
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch (_) {
    return {};
  }
}

function resolveRepoRoot(payload) {
  const candidate = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top || candidate;
  } catch (_) {
    return null; // not a git repo → caller skips git triggers
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return '';
  }
}

// Union of uncommitted changes + committed-vs-origin/main. Mirrors what the
// ship-time scanner scores touches[] against, so the advisory lines up with
// the real gate. Every git call is independently degradable.
function collectChangedFiles(root) {
  const set = new Set();
  // uncommitted (modified, added, untracked)
  const porcelain = git(['status', '--porcelain', '--untracked-files=all'], root);
  for (const line of porcelain.split('\n')) {
    const p = line.slice(3).trim();
    if (!p) continue;
    // rename lines look like "old -> new"; take the new path.
    const arrow = p.indexOf(' -> ');
    set.add(arrow >= 0 ? p.slice(arrow + 4) : p);
  }
  // committed vs origin/main (the branch footprint)
  const base = git(['merge-base', 'HEAD', 'origin/main'], root).trim();
  if (base) {
    const committed = git(['diff', '--name-only', `${base}...HEAD`], root);
    for (const f of committed.split('\n')) {
      const p = f.trim();
      if (p) set.add(p);
    }
  }
  return [...set];
}

function readSessionToken() {
  for (const name of ['gds-session.json', 'pms-session.json']) {
    try {
      const p = path.join(os.homedir(), '.config', 'otb', name);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.token) {
        return { token: j.token, apiBase: j.api_base || 'https://demo.cloudbongos.com', builderId: j.builder && j.builder.id };
      }
    } catch (_) { /* try next */ }
  }
  return null;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), { mode: 0o600 });
  } catch (_) { /* best-effort */ }
}

// Returns active_claims (array) or null if it couldn't be determined. Uses a
// 90s local cache; only hits the network when the cache is cold/stale, and
// falls back to a stale cache if the network is down.
async function resolveActiveClaims(cache, nowMs) {
  const sess = readSessionToken();
  if (!sess) return { claims: null, wandering: null, interaction: null, cache }; // no session → skip claim triggers

  const cached = cache.claim;
  const fresh = cached && cached.builder_id === sess.builderId
    && typeof cached.fetched_at === 'number'
    && (nowMs - cached.fetched_at) < CLAIM_TTL_MS;
  if (fresh) return { claims: cached.active_claims || [], wandering: cached.wandering || null, interaction: cached.interaction || null, cache };

  // Cold or stale → fetch (timeout-bounded, read-only GET, builder's own token).
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${sess.apiBase}/api/gds/me`, {
      headers: { Authorization: `Bearer ${sess.token}`, 'User-Agent': 'cloud-bongos-conductor-hook/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const claims = data.active_claims || (data.active_claim ? [data.active_claim] : []);
    const slim = claims.map((c) => ({ task_id: c.task_id, title: c.title, touches: c.touches || [] }));
    // task 1268: keep a slim copy of the resolved wandering knob (effective
    // level + whether to inject + the contract) so the focus advisory survives
    // the 90s cache + the offline-stale fallback, exactly like claims do.
    const w = data.wandering && typeof data.wandering === 'object'
      ? { effective_level: data.wandering.effective_level, inject: !!data.wandering.inject, contract: data.wandering.contract || '' }
      : null;
    // task 2010: slim copy of the resolved interaction profile (inject + contract)
    // so the standing "how to talk to this builder" advisory survives the cache
    // + offline-stale fallback, exactly like wandering.
    const ix = data.interaction && typeof data.interaction === 'object'
      ? { inject: !!data.interaction.inject, contract: data.interaction.contract || '' }
      : null;
    cache.claim = { builder_id: sess.builderId, fetched_at: nowMs, active_claims: slim, wandering: w, interaction: ix };
    return { claims: slim, wandering: w, interaction: ix, cache };
  } catch (_) {
    // Network down / aborted: prefer a stale cache over nothing; else unknown.
    if (cached && cached.builder_id === sess.builderId) return { claims: cached.active_claims || [], wandering: cached.wandering || null, interaction: cached.interaction || null, cache };
    return { claims: null, wandering: null, interaction: null, cache };
  }
}

async function main() {
  // settings.json invokes this directly (`node conductor.js`), so these env
  // kill-switches live here rather than in a bash shim: CLOUDBONGOS_CONDUCTOR_OFF is
  // the manual off-switch; CLOUDBONGOS_SUBAGENT is set by grader.js's runSubagent so
  // the Conductor never fires inside a grader/worker subagent. Either → no-op.
  if (process.env.CLOUDBONGOS_CONDUCTOR_OFF || process.env.CLOUDBONGOS_SUBAGENT) return;

  const payload = parsePayload(readStdin());
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const sessionId = payload.session_id || payload.sessionId || 'unknown';

  const root = resolveRepoRoot(payload);
  const changedFiles = root ? collectChangedFiles(root) : [];

  const nowMs = Date.now();
  let cache = readCache();
  const { claims, wandering, interaction, cache: cache2 } = await resolveActiveClaims(cache, nowMs);
  cache = cache2;

  const advisories = evaluateTriggers({ changedFiles, prompt, activeClaims: claims, wandering, interaction });

  // Two dedupe keys, both per-session:
  //   - advisory-set fingerprint (ids): gates the general block.
  //   - dispatch fingerprint (sensitive-file set): gates the Hacker directive,
  //     so it re-fires when a NEW security file enters the change set even if
  //     the advisory ids are otherwise unchanged.
  const fp = fingerprint(advisories);
  const dfp = dispatchFingerprint(advisories);
  const lastEmit = cache.last_emit || {};
  const sameSession = lastEmit.session_id === sessionId;
  const advRepeat = sameSession && lastEmit.fingerprint === fp;
  const dispatchNovel = dfp !== '' && !(sameSession && lastEmit.dispatch_fp === dfp);

  // Render when the advisory set is novel OR there's a novel dispatch. Show the
  // actionable dispatch directive only when the dispatch is novel.
  if (advisories.length > 0 && (!advRepeat || dispatchNovel)) {
    process.stdout.write(render(advisories, { showDispatch: dispatchNovel }) + '\n');
  }

  cache.last_emit = { session_id: sessionId, fingerprint: fp, dispatch_fp: dfp };
  writeCache(cache);
}

// Only run when executed directly (not when required by the test harness).
if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0));
}

module.exports = { evaluateTriggers, isCovered, matchSensitive, sensitiveFiles, fingerprint, dispatchFingerprint, render };
