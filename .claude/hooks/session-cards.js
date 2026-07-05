#!/usr/bin/env node
// task 1288 — deterministic delivery of READ-ONLY in-session cards.
//
// ## The methodology (why this hook exists)
//
// In-session "cards" (builder-start, status, …) own a deterministic render in
// their script, but DELIVERY used to be a model-mediated routine — detect the
// renderer, run the script, branch on its output, render — which fails on
// surfaces without `show_widget` (cloud/remote) or whenever the model freelances
// a summary instead. A hook can't render UI or even detect whether show_widget
// exists (no tool manifest reaches a hook), but it CAN do the deterministic part:
// match the intent, run the owning script's `--hook` mode, and inject the
// finished card + a one-step directive. The model's only remaining job is the
// irreducible one — emit it.
//
// ## Read-only only — mutating cards are deliberately NOT here
//
// This hook PRE-RUNS the owning script on prompt-submit. That is only safe for
// READ-ONLY commands (start.js, status.js just fetch + render). Mutating cards —
// /builder-claim (locks a task), /builder-ship (merges + deploys) — must NEVER
// be pre-run by a hook (it would claim/ship as a side effect of merely typing).
// They get the SAME determinism the safe way: the `lifecycle-card.js`
// PostToolUse hook delivers the card the script emits AFTER it does the work
// (backed by the scripts' in-band `[otb-card]` directive, tasks 1270/1282).
// Same methodology, post-run vehicle.
//
// ## Adding a card
//
// One CARDS entry. The script must support a `--hook` mode that prints
// {widgets_enabled, html, markdown, warnings} as JSON on stdout (the envelope) —
// see scripts/gds/start.js and scripts/gds/status.js.
//
// ## Discipline (mirrors .claude/hooks/conductor.js)
//
// Silent-failure: any non-match / missing session / parse error / timeout →
// exit 0, no output. A hook must never break a prompt. The only thing that ever
// reaches stdout is the additionalContext JSON. ZERO model calls. The script
// fetch only runs when a card's intent matches (a cheap regex), so cost is bound
// to exactly when the builder asked for that card.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------- registry + pure matchers (exported for tests) ----------

// builder-start: the slash command LEADS the prompt (optionally after run /
// please run) — a mid-sentence mention ("how does /builder-start work?") is a
// question, not an invocation. Plus the natural-language triggers.
const BUILDER_START_RE = /(?:^|\n)\s*(?:(?:please\s+)?run\s+)?\/builder-start\b|\bwhat can i (?:work on|claim)\b|\bwhat should i (?:work on|claim)\b|\bwhat'?s claimable\b|\bshow me (?:the |what'?s )?(?:claimable|tasks)\b/i;

// status: the /status command (same lead-the-prompt rule) or a project-status
// question. Mirrors conductor.js's STATUS_INTENT_RE shape, but here it DELIVERS
// the card rather than nudging toward it.
const STATUS_RE = /(?:^|\n)\s*(?:(?:please\s+)?run\s+)?\/status\b|\bwhat'?s (?:left|remaining)\b|\bwhat (?:tasks?|work|criteria|criterion) (?:are|is|remain|still)\b|\b(?:status|progress) of\b|\bhow far along\b|\bwhat'?s the status\b|\bremaining to (?:complete|finish|satisfy)\b/i;

// Pull an explicit version ("GDS-V4", "V2", "PMS-V1") and/or a criterion token
// ("C8") out of a status prompt so the card answers what was actually asked.
const VERSION_RE = /\b((?:GDS-|PMS-)?V\d+(?:\.\d+)?)\b/;
const CRITERION_RE = /\bC(\d+)\b/;

const CARDS = [
  {
    id: 'builder-start',
    title: 'builder_start_card',
    re: BUILDER_START_RE,
    script: 'scripts/gds/start.js',
    args: () => ['--hook'],
  },
  {
    id: 'status',
    title: 'status_card',
    re: STATUS_RE,
    script: 'scripts/gds/status.js',
    args: (prompt) => {
      const a = ['--hook'];
      const v = VERSION_RE.exec(prompt);
      if (v) a.push('--version', v[1]);
      const c = CRITERION_RE.exec(prompt);
      if (c) a.push(`C${c[1]}`);
      return a;
    },
  },
];

// First card whose intent matches (registry order = priority; builder-start
// wins a tie so its explicit triggers aren't shadowed by a loose status phrase).
function matchCard(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  for (const card of CARDS) {
    if (card.re.test(prompt)) return card;
  }
  return null;
}

const WH = '<<<WIDGET_HTML>>>';
const MD = '<<<MARKDOWN_CARD>>>';

// Build the additionalContext directive from a `--hook` envelope. Pure — no I/O —
// so a test can assert the branch logic + that the payloads are embedded
// verbatim. `env` = { widgets_enabled, html, markdown, warnings }; `title` is the
// show_widget title for this card. Returns '' when there's no usable card.
function buildAdditionalContext(env, title) {
  if (!env || typeof env !== 'object' || typeof title !== 'string') return '';
  const markdown = typeof env.markdown === 'string' ? env.markdown : '';
  if (!markdown && !env.html) return '';
  const warnings = Array.isArray(env.warnings) ? env.warnings.filter((w) => typeof w === 'string' && w.trim()) : [];
  const warnLine = warnings.length
    ? `\n- After the card, add this as ONE short plain line (a private note, not part of the card): ${warnings.join(' · ')}`
    : '';
  // Generic interaction contract: the card's rows use sendPrompt(), so a click
  // arrives as a NEW prompt next turn (claim a task, drill into a criterion, …).
  // The model just renders and waits; it never acts on the builder's behalf.
  const interaction = "\nAfter rendering, wait — a row click arrives as a new prompt (claim, drill in, …); handle that when it comes. Don't take an action on the builder's behalf unprompted.";
  const head = `[otb card — the ${title.replace(/_/g, ' ')} below was pre-rendered deterministically by the card-delivery hook (task 1288). Do NOT run the script yourself; do NOT rebuild it into prose, a table, a recommendation, or a recap. Deliver it in ONE step:]`;

  if (env.widgets_enabled && typeof env.html === 'string' && env.html.trim()) {
    return [
      head,
      `- If you have the \`mcp__visualize__show_widget\` tool: call \`mcp__visualize__read_me\` once this session (modules ["interactive","mockup"]) if you haven't, then call \`show_widget\` with title "${title}" and widget_code set to EXACTLY the HTML fenced by the WIDGET_HTML lines below. Render once.`,
      `- If you do NOT have \`show_widget\` (cloud/remote, plain terminal, cron, or any client without it): output the markdown fenced by the MARKDOWN_CARD lines below verbatim as your reply. Render once.` + warnLine,
      interaction,
      '',
      WH,
      env.html,
      WH,
      MD,
      markdown,
      MD,
    ].join('\n');
  }

  // Widgets off (task 1279) — markdown only, never a show_widget call.
  return [
    head,
    'The builder has widgets turned OFF (token-saving). Output the markdown fenced by the MARKDOWN_CARD lines below verbatim as your reply — once, no `show_widget` call, no rebuild, no recap.',
    interaction,
    '',
    MD,
    markdown,
    MD,
  ].join('\n');
}

// ---------- plumbing (each step degrades to a safe default) ----------

function readStdin() {
  try { return require('node:fs').readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function parsePayload(raw) {
  try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}

function resolveRepoRoot(payload) {
  const candidate = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top || candidate;
  } catch (_) {
    return candidate;
  }
}

// Run a card's `--hook` mode and return the parsed envelope, or null on any
// failure (no session, network down, timeout, bad JSON). The script prints the
// envelope as the only thing on stdout; warnings/errors go to stderr (ignored).
function fetchEnvelope(root, script, extraArgs) {
  try {
    const out = execFileSync(process.execPath, [path.join(root, script), ...extraArgs], {
      cwd: root, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    const j = JSON.parse(out);
    return j && typeof j === 'object' ? j : null;
  } catch (_) {
    return null;
  }
}

function main() {
  // Kill-switch + subagent guard (mirrors conductor.js): OTB_SESSION_CARDS_OFF
  // is the manual off-switch; OTB_SUBAGENT is set by the grader's runSubagent so
  // the hook never fires inside a grading/worker subagent.
  if (process.env.OTB_SESSION_CARDS_OFF || process.env.OTB_SUBAGENT) return;

  const payload = parsePayload(readStdin());
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const card = matchCard(prompt);
  if (!card) return;

  const root = resolveRepoRoot(payload);
  const env = fetchEnvelope(root, card.script, card.args(prompt));
  const ctx = buildAdditionalContext(env, card.title);
  if (!ctx) return; // no usable card → inject nothing (skill fallback still works)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }) + '\n');
}

// Only run when executed directly (not when required by the test harness).
if (require.main === module) {
  try { main(); } catch (_) { /* never break a prompt */ } finally { process.exit(0); }
}

module.exports = { matchCard, buildAdditionalContext, CARDS, BUILDER_START_RE, STATUS_RE, VERSION_RE, CRITERION_RE };
