#!/usr/bin/env node
// cascade-route.js — PreToolUse hook (System 3, task 1353): advise the cascade
// start-model for an in-session subagent (Task/Agent) spawn. A belt-and-braces
// complement to routing the routines' own spawns through src/bongos/cascade-dispatch
// — it nudges an interactive/autonomous session to draft a worker on the cheapest
// sufficient model and escalate only on signal, instead of defaulting to Opus.
//
// BUILT DISABLED (owner directive). Off unless CLOUDBONGOS_AUTONOMY_ENABLED=1 — then it
// emits an ADVISORY (additionalContext) only; it NEVER blocks or rewrites the
// spawn. When off it is a pure no-op (allow, no output). Mirrors the safety
// posture of worktree-guard.js: a hook must never break a turn, so EVERY error
// path exits 0 with no output (fail-open / allow).

'use strict';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 300);
  });
}

async function main() {
  try {
    if (process.env.CLOUDBONGOS_AUTONOMY_ENABLED !== '1') process.exit(0); // inert by default
    if (process.env.CLOUDBONGOS_SUBAGENT === '1') process.exit(0);          // don't nudge inside a worker

    let hook = {};
    try { hook = JSON.parse((await readStdin()) || '{}'); } catch (_) { process.exit(0); }
    const tool = hook.tool_name || hook.toolName;
    if (tool !== 'Task' && tool !== 'Agent') process.exit(0); // only subagent spawns

    const input = hook.tool_input || hook.toolInput || {};
    const text = `${input.description || ''} ${input.prompt || ''}`;
    let startModel = 'sonnet';
    try {
      const { startRungForTask, LADDER } = require('../../src/bongos/cascade-dispatch');
      startModel = LADDER[startRungForTask({ title: input.description, description: input.prompt })];
    } catch (_) { /* lib unavailable → generic advice */ }

    const advice = `Cascade routing (System 3): consider drafting this worker on \`${startModel}\` (the cheapest sufficient model for this kind of task) and escalating to a dearer model only on an objective signal — a schema-validate fail or a self-reported CONFIDENCE: low. Never exceed your configured model ceiling.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: advice },
    }));
    process.exit(0);
  } catch (_) {
    process.exit(0); // fail-open: never block a spawn
  }
}

if (require.main === module) main();
