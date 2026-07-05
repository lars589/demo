#!/usr/bin/env node
// worktree-guard.js — PreToolUse hook: refuse a file write that would land in the
// WRONG git checkout. V4.R13 / #951 (criterion: machine-room-ergonomics).
//
// THE PROBLEM (the corpus's #1 tool-error class — 84 hits; sessions 196/415/1507).
// When a session runs inside a linked git worktree (.claude/worktrees/<name>),
// agents — especially subagents and Explore, which report MAIN-checkout absolute
// paths — write to `<main>/server.js` instead of `<worktree>/server.js`. The edit
// silently lands in the wrong tree: it's not in the branch being shipped, and it
// dirties the main checkout. The project's standing rule (memory
// feedback_edit_under_worktree_path) is "always edit under the worktree root";
// this hook is the deterministic backstop for that rule.
//
// WHAT IT DOES. On a guarded write (Edit/Write/MultiEdit/NotebookEdit) it resolves
// the session's worktree root and the repo's main checkout. If the target file is
// inside the repo but NOT under the session's worktree, it DENIES the call and
// hands back the corrected path under the worktree root, so the agent re-issues it
// correctly. Writes to the correct tree, to files outside the repo (~/.config, …),
// or in a non-worktree session (main checkout) all pass untouched.
//
// SAFETY POSTURE (a hook must NEVER break a turn — same rule as the other hooks):
//   • Any error / unresolvable git / missing field → exit 0 with no output (allow).
//   • OTB_ALLOW_CROSS_TREE=1 → documented opt-out for a deliberate cross-tree edit.
//   • Non-guarded tools (Bash, Read, …) → allow. Git-op detection is intentionally
//     out of scope here (too noisy; pre-push.js + the merge-time collision check
//     cover git) — the documented failure is wrong-tree WRITES, which this catches.
//
// Wired in .claude/settings.json as a PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit).

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GUARDED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function allow() { process.exit(0); }

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', () => resolve(buf));
    } catch { resolve(buf); }
  });
}

// child === parent or strictly under it (path-segment aware; resolves both).
function isUnder(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

// ---- pure decision core (unit-tested in tests/worktree_guard.mjs) ----------
// Returns { deny:false } or { deny:true, reason }. No I/O.
function decideWorktreeGuard({ toolName, toolInput, worktreeRoot, mainRoot }) {
  if (!GUARDED_TOOLS.has(toolName)) return { deny: false };
  const filePath = (toolInput && (toolInput.file_path || toolInput.notebook_path)) || null;
  // A relative path resolves against cwd (= the worktree), so it's already correct.
  if (!filePath || !path.isAbsolute(filePath)) return { deny: false };
  // Couldn't resolve the roots → fail open. Not in a worktree (roots equal) → no-op.
  if (!worktreeRoot || !mainRoot) return { deny: false };
  if (path.resolve(worktreeRoot) === path.resolve(mainRoot)) return { deny: false };
  // Correct tree, or a file entirely outside the repo (legit external) → allow.
  if (isUnder(filePath, worktreeRoot)) return { deny: false };
  if (!isUnder(filePath, mainRoot)) return { deny: false };

  // Inside the repo but NOT under this session's worktree → wrong tree.
  const rel = path.relative(mainRoot, path.resolve(filePath));
  const intoSibling = rel.split(path.sep).slice(0, 2).join('/') === '.claude/worktrees';
  const corrected = intoSibling ? null : path.join(worktreeRoot, rel);
  const reason = corrected
    ? `Wrong git checkout. ${filePath} is in the MAIN checkout, but this session's worktree is:\n  ${worktreeRoot}\nRe-issue this write on the worktree copy instead:\n  ${corrected}\n(Worktree guard #951 — catches the corpus's #1 error class: writes landing in the wrong tree. Deliberate cross-tree edit? Set OTB_ALLOW_CROSS_TREE=1.)`
    : `Wrong git checkout. ${filePath} is in a DIFFERENT worktree than this session's:\n  ${worktreeRoot}\nRe-target the path under this worktree. (Worktree guard #951; OTB_ALLOW_CROSS_TREE=1 to bypass.)`;
  return { deny: true, reason };
}

// Resolve { worktreeRoot, mainRoot } from a cwd via git. Best-effort: any failure
// returns nulls so the caller fails open. mainRoot = dirname(git-common-dir): for a
// linked worktree the common dir is <main>/.git; for the main checkout it is also
// <main>/.git, so mainRoot === worktreeRoot there and the guard no-ops.
function resolveRoots(cwd, run = execFileSync) {
  const git = (args) => run('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const worktreeRoot = git(['rev-parse', '--show-toplevel']) || null;
    let common;
    try { common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']); }
    catch { common = git(['rev-parse', '--git-common-dir']); } // older git: may be relative
    if (common && !path.isAbsolute(common)) common = path.resolve(cwd, common);
    const mainRoot = common ? path.dirname(common) : null;
    return { worktreeRoot, mainRoot };
  } catch {
    return { worktreeRoot: null, mainRoot: null };
  }
}

async function main() {
  if (process.env.OTB_ALLOW_CROSS_TREE) allow(); // documented opt-out
  let hook = {};
  try { hook = JSON.parse((await readStdin()) || '{}'); } catch { allow(); }
  if (!GUARDED_TOOLS.has(hook.tool_name)) allow(); // fast path: most calls aren't writes
  const cwd = hook.cwd || process.cwd();
  const { worktreeRoot, mainRoot } = resolveRoots(cwd);
  let decision = { deny: false };
  try {
    decision = decideWorktreeGuard({ toolName: hook.tool_name, toolInput: hook.tool_input, worktreeRoot, mainRoot });
  } catch { allow(); }
  if (!decision.deny) allow();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  }));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0)); // any unexpected throw → allow the write.
}

module.exports = { decideWorktreeGuard, resolveRoots, isUnder, GUARDED_TOOLS };
