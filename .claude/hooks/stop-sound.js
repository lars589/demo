#!/usr/bin/env node
// Cross-platform Stop hook — 5-event sound system (#781).
//
// Plays a sound when a Claude turn ends, chosen by flag files in the OS temp
// dir. Priority order (highest first):
//
//   Flag file             Sound         When to use
//   ─────────────────── ─────────────  ──────────────────────────────────────
//   otb-promotion        fanfare        rank promotion (written by ship.js)
//   otb-celebrate        triumph        big milestone  (touch <TMP>/otb-celebrate)
//   otb-needs-input      alert          waiting on user (touch <TMP>/otb-needs-input)
//   (none)               chime          routine turn end (default)
//
// The "ship" sound (ship.wav) is played directly by scripts/gds/ship.js after
// deploy — it doesn't go through this hook because ship.js runs as its own
// process, not inside a Claude turn.
//
// Flag path convention:
//   macOS / Linux   /tmp/otb-<name>               (touch /tmp/otb-celebrate)
//   Windows         %TEMP%\otb-<name>
//
// Wired in .claude/settings.json:
//   node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-sound.js"

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { playSound } = require(path.join(__dirname, '../sounds/play.js'));

// Cross-platform temp dir: /tmp on macOS/Linux, %TEMP% on Windows.
const TMP = process.platform === 'win32'
  ? (process.env.TEMP || process.env.TMP || require('node:os').tmpdir())
  : '/tmp';

function flag(name) { return path.join(TMP, `otb-${name}`); }

function consumeFlag(name) {
  const f = flag(name);
  if (!fs.existsSync(f)) return false;
  try { fs.rmSync(f, { force: true }); } catch (_) { /* best-effort */ }
  return true;
}

// Also clean up the legacy message file that may accompany otb-celebrate.
function cleanLegacy() {
  try { fs.rmSync(path.join(TMP, 'otb-celebrate-message'), { force: true }); } catch (_) {}
}

// Read the builder's per-event wav map from the local prefs file (written by
// fetch-sound-prefs.js at session start). Falls back to the system defaults so
// a fresh machine or a missing file still plays sensible sounds.
function eventWav(eventId) {
  try {
    const raw = fs.readFileSync(
      path.join(require('node:os').homedir(), '.config', 'otb', 'sound-prefs.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw);
    const map = parsed && parsed.event_sounds;
    if (map && typeof map === 'object' && typeof map[eventId] === 'string') {
      return map[eventId];
    }
  } catch (_) { /* fall through to default */ }
  // System defaults mirror event-sound-prefs.js EVENT_DEFAULT → VARIANT_WAV.
  const defaults = {
    'user-input':      'alert',
    'task-shipped':    'ship',
    'credits-awarded': 'chime',
    'rank-promoted':   'fanfare',
    'achievement':     'triumph',
  };
  return defaults[eventId] ?? 'chime';
}

if (consumeFlag('promotion')) {
  playSound(eventWav('rank-promoted'));
} else if (consumeFlag('celebrate')) {
  cleanLegacy();
  playSound(eventWav('achievement'));
} else if (consumeFlag('needs-input')) {
  playSound(eventWav('user-input'));
} else if (consumeFlag('credits')) {
  playSound(eventWav('credits-awarded'));
} else {
  playSound('chime');
}

process.exit(0);
