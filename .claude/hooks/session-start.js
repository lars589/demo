#!/usr/bin/env node
// Cross-platform SessionStart hook entry (#671).
//
// Replaces the bash `sync-env-local.sh` chain so SessionStart works on Windows
// (no Git Bash dependency), macOS, and Linux alike — node is the project's
// guaranteed runtime, and .claude/settings.json's SessionEnd hooks already use
// this same `node "$CLAUDE_PROJECT_DIR/..."` form. Wired as:
//   node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.js"
//
// Runs the exact same chain the bash version did, in order:
//   1. Auto-provision .env.local into a fresh worktree (the sync-env-local.sh
//      job): copy it from the main checkout, or print the "run /builder-setup"
//      guidance when the main checkout has none.
//   2. Onboarding-friction pipeline (was onboarding-ship-logs.sh): stage
//      transcripts (sync) + kick analysis (detached). Both self-gate on consent.
//   3. Promotion/demotion greeting (was rank-change-greeting.sh → now .js).
//   4. Memory pull-on-session-start (was pull-memory.sh → pull-memory.js),
//      preserving the OTB_MEMORY_PULL_OFF + OTB_SUBAGENT kill-switches.
//
// Every step is best-effort and isolated: a failure in one never blocks session
// start or the others. Child node scripts are spawned with process.execPath
// (the absolute path to the running node), which resolves on Windows cmd.exe
// regardless of PATH — the robustness #660 established for ship.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');

// <root>/.claude/hooks/session-start.js → root is two levels up. Prefer the
// env Claude Code sets, fall back to the resolved path so a hand-run still works.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

// ---- 1. .env.local provisioning (port of sync-env-local.sh) ----
function syncEnvLocal() {
  const toplevel = git(['rev-parse', '--show-toplevel']);
  if (!toplevel) return;
  // The first `worktree` line of the porcelain output is always the main checkout.
  const wtList = git(['worktree', 'list', '--porcelain']);
  if (!wtList) return;
  const firstLine = wtList.split('\n').find((l) => l.startsWith('worktree '));
  const mainRoot = firstLine ? firstLine.slice('worktree '.length).trim() : '';
  if (!mainRoot) return;

  // Nothing to provision when we ARE the main checkout, or it's already here.
  if (path.resolve(toplevel) === path.resolve(mainRoot)) return;
  if (fs.existsSync(path.join(toplevel, '.env.local'))) return;

  const mainEnv = path.join(mainRoot, '.env.local');
  if (fs.existsSync(mainEnv)) {
    try {
      fs.copyFileSync(mainEnv, path.join(toplevel, '.env.local'));
      console.log('[otb] Copied .env.local from the main checkout into this worktree.');
    } catch (_) { /* best-effort */ }
  } else {
    console.log('[otb] No .env.local in the main checkout. If you need local secrets, run /builder-setup.');
    console.log("[otb] (The art pipeline's Google AI Studio key also resolves from ~/.config/otb/env, which survives worktree churn.)");
  }
}

// Spawn a sibling node script synchronously, forwarding its stdout to ours (so
// greetings + memory status reach the session-start context). Errors swallowed.
// windowsHide keeps the child from flashing a console window on Windows.
function runNodeSync(scriptPath, args = []) {
  try {
    spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'inherit', 'ignore'],
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });
  } catch (_) { /* best-effort */ }
}

// Spawn detached + unref'd so it outlives this hook without delaying start.
// windowsHide is REQUIRED here: a `detached` child on Windows without it briefly
// flashes a console window — a visible glitch on the very platform this targets.
function runNodeDetached(scriptPath, args = []) {
  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });
    child.unref();
  } catch (_) { /* best-effort */ }
}

// ---- 0. Project identity card (#1254) ----
// The ONE context guarantee that survives every local entrypoint. The terminal
// CLI auto-loads CLAUDE.md + the file-based memory; Claude Desktop/Cowork
// sessions can start WITHOUT either (proven 2026-06-19: a Desktop session didn't
// know "Cloud Bongos" was this very platform and web-searched the name as if it
// were an external product). This hook's stdout DOES reach every local session's
// context, so a few lines here mean no local session ever starts blind about
// what it's working on. Identity strings come from the branding contract
// (config/branding.json resolved over the neutral starter) so each Cloud Bongos
// instance prints its OWN identity and the card can't drift; the platform line
// is the portable-core constant. Best-effort: any failure prints nothing and
// never blocks session start. Skipped inside grader/subagent runs (OTB_SUBAGENT)
// to keep their context clean.
function printIdentityCard() {
  if (process.env.OTB_SUBAGENT) return;
  let b;
  try {
    b = require(path.join(PROJECT_DIR, 'src', 'branding.js')).loadBranding();
  } catch (_) {
    return; // no/!invalid branding contract → say nothing rather than guess
  }
  try {
    const id = b.identity || {};
    const product = id.productName || 'this project';
    const world = id.worldName;
    const company = id.company && id.company.name;
    const tag = `[${(b.envPrefix || 'cloudbongos').toLowerCase()}]`;
    let who = `${tag} Project: ${product}`;
    if (world && world !== product) who += ` — the ${world} world`;
    if (company) who += `, by ${company}`;
    console.log(`${tag} ── who you're working on (so you're not flying blind) ──`);
    console.log(who);
    console.log(`${tag} Built on Cloud Bongos — the AI-first build platform (renamed from "Medusa"; ADR 0064).`);
    console.log(`${tag} Live state (tasks/versions/ranks/costs) is the GDS DB, not these files — run /builder-start, /status, /recall.`);
    console.log(`${tag} Full framing is CLAUDE.md at the repo root — read it if it isn't already in context.`);
  } catch (_) { /* never block session start */ }
}

// ---- 0.2. Dev-box preview card (task 1443) ----
// On a dev box the game preview is HOSTED at https://sandbox-<login>.<apex> (ADR
// 0044), reached over the Cloudflare tunnel — NOT localhost. But the harness
// preview tools (.claude/launch.json) and `npm run preview` bind http://localhost,
// which the builder's own browser can't reach when the server is on a remote box.
// A session that reaches for those hands the builder a dead localhost link (the
// reported Builder-25 symptom). This card — printed ONLY on a box — surfaces the
// real hosted URL and steers off localhost, so a box session never previews wrong.
// Best-effort: a laptop has no /etc/otb/box.env → reads throw → nothing prints.
// Skipped in subagents (OTB_SUBAGENT) to keep grader/worker context clean.
function printBoxPreviewCard() {
  if (process.env.OTB_SUBAGENT) return;
  let envText;
  try { envText = fs.readFileSync('/etc/otb/box.env', 'utf8'); } catch (_) { return; } // not a box (or unreadable) → say nothing
  try {
    const m = /^\s*(?:export\s+)?BOX_PREVIEW_HOSTNAME=(.*)$/m.exec(String(envText || ''));
    const host = m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : '';
    console.log("[otb] ── dev box: your game preview is HOSTED, not localhost ──");
    if (host) {
      console.log(`[otb] Sandbox: https://${host}  — run /builder-stage to refresh it with your current edits.`);
    } else {
      console.log('[otb] Sandbox URL: run `box-preview status` (no named-tunnel hostname is baked into this box).');
    }
    console.log("[otb] Do NOT preview via the Claude Code preview tools or `npm run preview`/`npm start` here — they bind localhost, which the builder's browser cannot reach. Hand them the hosted URL above.");
  } catch (_) { /* never block session start */ }
}

// ---- 0.5. Freshness: fast-forward to origin/main when safe, else warn (#1277; was the warn-only #1258) ----
// A new session should start on CURRENT code. CLAUDE.md, the file-based memory,
// and these very hooks are loaded ONCE at startup, and on a dev box the
// box-source-fetch cron only freshens /workspace, only every ~10 min, and only
// fast-forwards — so without this a fresh session can run behind origin/main
// until the next tick. We always do a bounded, NON-mutating `git fetch origin
// main`, then EITHER fast-forward the checkout or warn:
//
//   * Fast-forward (the #1277 reversal of the old "nothing pulls at session
//     start" rule) ONLY when it is unambiguously safe:
//       - on branch `main`            — never pull origin/main into a feature
//                                       branch / worktree (that's a rebase, not
//                                       this hook's job);
//       - zero local commits ahead    — strictly behind ⇒ a real fast-forward,
//                                       never a merge commit;
//       - no modified/staged tracked files (untracked/ignored are fine, so a box
//         with stray logs still qualifies) — an ff then can't shadow local work;
//       - a FULL clone, not a partial/blobless one — on a `--filter=blob:none`
//         box, checkout lazily fetches blobs over the network, which the bounded
//         merge could interrupt; leave those to the cron.
//     Pulling at the moment work begins beats polling the cron faster (cron
//     can't go sub-minute, every tick hammers the prod /box/source-access
//     endpoint, and a frequent pull risks yanking files under an active
//     session). A fast-forward on a clean `main` full clone is local + fast, so
//     the bounded merge effectively never trips; if it ever does, the box cron
//     is still the backstop, so we're never worse than before. (ADR 0067.)
//
//   * Otherwise — warn, exactly as before, so a feature-branch worktree / dirty /
//     diverged checkout still learns it may be stale. Feature-branch worktrees
//     are the common laptop case, which also sidesteps the Mac iCloud-mmap risk:
//     the merge only runs on a clean `main` (ext4 on the box).
//
// Bounded + fail-open throughout: a slow/offline network or any git error never
// blocks or delays session start. Off-switch OTB_FRESHNESS_CHECK_OFF; skipped in
// subagents. NB even on a successful pull, the control surfaces loaded for THIS
// session (CLAUDE.md / hooks / memory) reflect the pre-pull state until the next
// session — the success line says so.
// Pure decision (exported for tests; no I/O): given facts about the checkout vs
// origin/main, decide whether to fast-forward, warn, or stay silent.
//   behind:  int commits HEAD..origin/main (≤0 or NaN ⇒ up to date / unknown)
//   ahead:   int commits origin/main..HEAD
//   branch:  current branch ('main', a feature branch, or 'HEAD' when detached)
//   hasTrackedChanges: modified/staged tracked files present (untracked don't count)
//   isPartialClone:    a --filter clone whose checkout would fetch over the network
// Returns { action: 'skip' | 'pull' | 'warn', reason }. 'pull' is emitted ONLY
// when a fast-forward is unambiguously safe (see ADR 0067); every other behind
// case is 'warn'; up-to-date (or unknowable) is 'skip'.
function decideFreshness({ behind, ahead, branch, hasTrackedChanges }) {
  if (!Number.isFinite(behind) || behind <= 0) {
    return { action: 'skip', reason: 'up-to-date-or-unknown' };
  }
  // A fast-forward is safe whenever there are no local commits to replay
  // (ahead===0 ⇒ the checkout is a strict ancestor of origin/main, so
  // `merge --ff-only` is a pure pointer advance) AND no uncommitted tracked
  // changes to clobber — regardless of branch NAME or clone TYPE. A feature-branch
  // worktree strictly behind FFs cleanly, and a blob:none partial clone fetches
  // the few needed objects on the spot. This lets a freshly-branched dev-box
  // worktree (always a feature branch off a partial clone) self-heal at session
  // start instead of silently running stale code (task 1284). The one exclusion
  // is a detached HEAD — an intentional "inspecting this commit" state we don't
  // move out from under.
  if (Number.isFinite(ahead) && ahead === 0 && !hasTrackedChanges && branch !== 'HEAD') {
    return { action: 'pull', reason: 'safe-fast-forward' };
  }
  let reason = 'unknown';
  if (!Number.isFinite(ahead) || ahead !== 0) reason = 'local-commits-ahead';
  else if (hasTrackedChanges) reason = 'dirty-tree';
  else if (branch === 'HEAD') reason = 'detached-head';
  return { action: 'warn', reason };
}

function freshenOrWarn() {
  if (process.env.OTB_SUBAGENT || process.env.OTB_FRESHNESS_CHECK_OFF) return;
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
  try {
    // Bounded so a slow/offline network never delays session start; a timeout
    // or any failure just means we skip (fail-open).
    const r = spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], {
      cwd: PROJECT_DIR, stdio: 'ignore', timeout: 4000, windowsHide: true,
    });
    if (r.status !== 0) return; // includes timeout (status null) and fetch error
  } catch (_) { return; }

  // Gather the facts the decision needs, then decide (pure) — see decideFreshness.
  const behind = Number.parseInt(git(['rev-list', '--count', 'HEAD..origin/main']), 10);
  const ahead = Number.parseInt(git(['rev-list', '--count', 'origin/main..HEAD']), 10);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); // 'main', a branch, or 'HEAD' (detached)
  const porcelain = git(['status', '--porcelain']); // '' clean, non-empty dirty, null on error
  const hasTrackedChanges = porcelain == null
    ? true // can't tell → treat as unsafe
    : porcelain.split('\n').filter(Boolean).some((l) => !l.startsWith('??'));
  const decision = decideFreshness({ behind, ahead, branch, hasTrackedChanges });
  if (decision.action === 'skip') return; // up to date, or can't tell

  if (decision.action === 'pull') {
    let merged = false;
    try {
      // Local + fast on a full clone, but still bounded so a pathological hang
      // can't wedge session start. On any failure we fall through to the warning.
      const m = spawnSync('git', ['merge', '--ff-only', 'origin/main'], {
        cwd: PROJECT_DIR, stdio: 'ignore', timeout: 20000, windowsHide: true,
      });
      merged = m.status === 0;
    } catch (_) { merged = false; }
    if (merged) {
      console.log(`[otb] ✓ fast-forwarded this checkout ${behind} commit(s) to origin/main.`);
      console.log('[otb]   (CLAUDE.md, the hooks, and the memory for THIS session reflect the pre-pull state — restart the session to pick those up.)');
      return;
    }
    // ff failed (race / would-overwrite-untracked / network) → warn below.
  }

  // Behind but not auto-pulled (a 'warn' decision, or a 'pull' whose merge failed)
  // — warn so the session knows it may be stale.
  console.log(`[otb] ⚠ this checkout is ${behind} commit(s) behind origin/main — not auto-pulled.`);
  console.log('[otb]   CLAUDE.md, the hooks, and the memory loaded just now reflect that older state and may be STALE (code staleness is caught at ship-time merge; startup-loaded surfaces are not).');
  if (branch === 'main') {
    console.log('[otb]   Resolve local changes if any, then:  git pull --ff-only origin main');
  } else if (branch && branch !== 'HEAD') {
    console.log(`[otb]   You're on '${branch}', not main — when ready:  git fetch origin main && git rebase origin/main`);
  } else {
    console.log('[otb]   Detached HEAD — check out a branch, then:  git pull --ff-only origin main');
  }
}

function main() {
  // 0. Project identity card — print first so it's at the top of the
  //    session-start context, before any of the status lines below.
  try { printIdentityCard(); } catch (_) { /* never block */ }

  // 0.1. Dev-box auth gate — the FIRST thing a box session confirms: that its
  //      GDS session is a REAL, non-box-scoped CLI session (not the bootstrap
  //      token, not expired). Box-scoped/expired → a loud "re-auth first"
  //      directive; else silent (or a quiet ✓). Placed first (right after the
  //      identity card) so the directive tops the session context and no work
  //      starts on a token that can't ship it — the 2026-07-02 publish-wall
  //      incident. Self-gates OFF a box and in subagents, and self-bounds its
  //      one network call, so this is a fast no-op everywhere but a box (task 1712).
  const boxAuth = path.join(PROJECT_DIR, 'scripts', 'gds', 'box-auth-check.js');
  if (fs.existsSync(boxAuth)) runNodeSync(boxAuth);

  // 0.2. Dev-box preview card — only prints on a box; steers previews to the
  //      hosted sandbox URL instead of an unreachable localhost (task 1443).
  try { printBoxPreviewCard(); } catch (_) { /* never block */ }

  // 0.5. Freshness — fast-forward a stale checkout to origin/main when safe, else
  //      warn. Right after the identity card, since both are session orientation.
  //      Bounded network/git calls; fail-open (never blocks session start).
  try { freshenOrWarn(); } catch (_) { /* never block */ }

  // 1. .env.local provisioning.
  try { syncEnvLocal(); } catch (_) { /* never block */ }

  // 2. Onboarding-friction pipeline (was onboarding-ship-logs.sh). Both scripts
  //    self-gate on consent + window, so they no-op in milliseconds for anyone
  //    not in an onboarding window. Stage sync, analyze detached.
  const shipLogs = path.join(PROJECT_DIR, 'scripts', 'gds', 'onboarding-ship.js');
  if (fs.existsSync(shipLogs)) {
    runNodeSync(shipLogs, ['--cwd', PROJECT_DIR, '--quiet']);
    const analyze = path.join(PROJECT_DIR, 'scripts', 'gds', 'onboarding-analyze.js');
    if (fs.existsSync(analyze)) runNodeDetached(analyze, ['--quiet']);
  }

  // 3. Promotion/demotion greeting (was rank-change-greeting.sh).
  const rankGreeting = path.join(__dirname, 'rank-change-greeting.js');
  if (fs.existsSync(rankGreeting)) runNodeSync(rankGreeting);

  // 4. Memory pull-on-session-start (was pull-memory.sh → pull-memory.js).
  //    Preserve the bash shim's two kill-switches: never pull inside a grader
  //    subagent (OTB_SUBAGENT) or when explicitly disabled (OTB_MEMORY_PULL_OFF).
  if (!process.env.OTB_SUBAGENT && !process.env.OTB_MEMORY_PULL_OFF) {
    const pullMemory = path.join(__dirname, 'pull-memory.js');
    if (fs.existsSync(pullMemory)) runNodeSync(pullMemory);
  }

  // 5. Sound-prefs mirror (#786): fetch the builder's per-sound on/off prefs and
  //    write them to ~/.config/otb/sound-prefs.json so the local player honors
  //    them. Detached — it's a best-effort network call that must never delay
  //    session start; a stale/absent file just means the player fails open.
  if (!process.env.OTB_SUBAGENT) {
    const fetchSoundPrefs = path.join(PROJECT_DIR, 'scripts', 'gds', 'fetch-sound-prefs.js');
    if (fs.existsSync(fetchSoundPrefs)) runNodeDetached(fetchSoundPrefs);
  }

  // 5b. Shared art-key mirror (#1281): fetch the GDS-delivered shared Gemini key
  //     (newcomers only) and write/remove ~/.config/otb/gds-session.json's
  //     shared_gemini_api_key field so the local art pipeline can use it. Same
  //     detached, best-effort posture as the sound-prefs mirror — a stale/absent
  //     field just means the pipeline falls back to the builder's own key (or its
  //     normal "set a key" message). Re-run every session so promotion to Thetes
  //     withdraws the key automatically.
  if (!process.env.OTB_SUBAGENT) {
    const fetchArtKey = path.join(PROJECT_DIR, 'scripts', 'gds', 'fetch-art-key.js');
    if (fs.existsSync(fetchArtKey)) runNodeDetached(fetchArtKey);
  }

  // 6. Session-start recall hints (#963 / V4.R25, criterion sessions-start-knowing).
  //    When the session opens holding an active claim, surface the top recall hits
  //    for that task so the agent starts pointed at the relevant docs. SYNC so the
  //    hints reach the session-start context; the script self-bounds to <2s and is
  //    silent on any miss. Same two-switch pattern as the memory pull: never in a
  //    grader subagent (OTB_SUBAGENT), and an explicit off switch (OTB_RECALL_HINTS_OFF).
  if (!process.env.OTB_SUBAGENT && !process.env.OTB_RECALL_HINTS_OFF) {
    const recallHints = path.join(__dirname, 'recall-hints.js');
    if (fs.existsSync(recallHints)) runNodeSync(recallHints);
  }
}

// Direct run (the SessionStart hook invocation, `node .../session-start.js`) —
// run the chain and exit. A `require()` of this file (tests importing
// decideFreshness) must NOT run the chain or call process.exit, so guard on
// require.main; the export below stays reachable either way.
if (require.main === module) {
  main();
  process.exit(0);
}

module.exports = { decideFreshness, freshenOrWarn };
