// .claude/hooks/eviction-policy.js — System 2 (task 1348), the deterministic
// in-session compaction classifier. PURE: transcript turns in → an eviction set
// + one-line replacement stubs out. No I/O, no Date.now, no network — so it is
// hermetically unit-tested (tests/eviction_policy.mjs) and the PreCompact hook
// (.claude/hooks/pre-compact.js, task 1349) is a thin reader/formatter around it.
//
// WHY. A marathon Opus session's cost is the integral of a growing context
// prefix re-billed as cache_read on every turn. Spike 1347 measured ~24% of
// tool-output tokens in real OTB sessions as provably stale (superseded reads,
// duplicate reads, large search/ls dumps). Dropping that at the PreCompact
// boundary (already a cache-reset point) makes the rewritten working set smaller
// and longer-lived. Recovery is retrieval-first: an evicted block leaves a stub
// pointing at /recall or a re-Read (task 1350).
//
// SAFETY IS THE FIRST PRINCIPLE. We only ever target `tool_result` blocks, and
// only when a definitive newer source of truth exists (a later edit, a newer
// read) or the block is an old, uncited bulk dump. We NEVER touch user turns,
// assistant text/reasoning, the claim context-pack, worktree guidance, the last
// N turns, or the newest read of any file. When in doubt we keep.

'use strict';

const DEFAULTS = {
  recencyTurns: 12,        // the last N message-turns are the live working set — never evicted
  dumpMinTokens: 300,      // a Grep/Glob/LS/Bash result at/above this is a "bulk dump"
  livenessAnchorChars: 40, // a later turn quoting a ≥this-long line of a dump keeps it (exact-quote liveness)
  livenessTokenOverlap: 3, // …or reusing ≥this many of the dump's distinctive identifiers/paths (paraphrase liveness, task 1364)
  // Content that must never be evicted even if it looks like tool output. The
  // claim context-pack, worktree-path guidance, and harness system-reminders are
  // load-bearing orientation; an injected system-reminder may arrive as a
  // user/tool block, so we guard by content match, not just by role.
  neverEvictPatterns: [
    /context[ -]?pack/i,
    /worktree/i,
    /Off the Boats · task #/, // the claim lifecycle card
    /<system-reminder>/i,
    /You are an autonomous overnight builder/i,
  ],
};

const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const DUMP_TOOLS = new Set(['Grep', 'Glob', 'LS', 'Bash']);

// chars/4 — the standard rough token estimate. We report/threshold on ratios and
// relative sizes, so the constant factor is immaterial.
function estTokens(s) {
  return Math.ceil((s ? String(s).length : 0) / 4);
}

// Flatten a message `content` (string | array of blocks) to text, for pattern
// matching + the liveness scan.
function blockText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('\n');
  if (typeof content === 'object') {
    return blockText(content.text != null ? content.text : (content.content != null ? content.content : ''));
  }
  return String(content);
}

function targetFile(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.path || input.notebook_path || null;
}

// The recoverable "what" for a fileless dump (Grep/Glob/Bash/LS): the pattern,
// glob, or command. Task 1350 turns this into a one-step /recall hint in the
// eviction stub so an evicted dump routes straight to the retrieval layer
// (src/bongos/search.js searchChunks via /recall) or a re-run of the same tool.
function dumpQuery(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (input.pattern) return String(input.pattern).slice(0, 80);
  if (input.query) return String(input.query).slice(0, 80);
  if (input.command) return String(input.command).slice(0, 80);
  return null;
}

// The line interval a Read covers: { start, end } (1-based, inclusive). `offset`
// is the 1-based first line (default 1); `limit` is the line count; no/0 limit
// means "to end of file" → Infinity. The duplicate/superseded rules compare these
// so a Read of one slice can't evict a Read of a DIFFERENT slice of the same file
// (task 1364).
function readRange(input) {
  const off = input && Number.isFinite(input.offset) ? Math.max(1, Math.floor(input.offset)) : 1;
  const lim = input && Number.isFinite(input.limit) ? Math.floor(input.limit) : null;
  return { start: off, end: lim != null && lim > 0 ? off + lim - 1 : Infinity };
}

// Does `outer` fully contain `inner`? A later Read only makes an earlier one a
// true duplicate when it COVERS the earlier read's interval — a later partial
// slice does NOT supersede an earlier wider/whole read of the same file.
function covers(outer, inner) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

// A whole-file read (no offset, no limit). The superseded rule fires only on
// these: for a partial read we can't locate an Edit relative to the slice (Edit
// carries no line range), so a small edit must not drop a disjoint partial read
// (task 1364).
function isFullRead(range) {
  return range.start === 1 && range.end === Infinity;
}

// A Bash command whose output is non-reproducible (randomness, timestamps) OR
// whose run already mutated state (a migration, a commit, a write): re-running it
// yields a DIFFERENT value, or the one-time effect has already happened. Such a
// result is irrecoverable, so it must NEVER be evicted as a stale_dump — the
// stub's "re-run Bash" recovery would be actively wrong (task 1364). Safety-first:
// any risk marker ⇒ keep. (Pure read commands — cat/grep/ls/find/wc/head/sort/jq
// without redirects — match nothing here and stay evictable.)
const VOLATILE_BASH_PATTERNS = [
  // non-deterministic output
  /\bopenssl\s+rand\b/i, /\brand(om)?\b/i, /\buuidgen\b/i, /\/dev\/u?random\b/i,
  /\$RANDOM\b/, /\bmktemp\b/i, /\bshuf\b/i, /\bnanoid\b/i,
  /\bdate\b/i, /\+%-?[a-zA-Z]/, /\bnow\(\)/i, /\bepoch\b/i,
  // state mutation / one-time side effects
  /\bgit\s+(commit|push|merge|tag|rebase|reset|cherry-pick|revert|stash|am|apply)\b/i,
  /\b(migrate|migration)\b/i,
  /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/i,
  /\b(npm|yarn|pnpm|pip|pip3|brew|apt|apt-get|gem|cargo)\s+(install|add|i|uninstall|remove|publish)\b/i,
  /\bnpm\s+(run|test|start|exec)\b/i,
  /\b(mkdir|rmdir|rm|mv|cp|touch|ln|chmod|chown|kill|killall|tee|dd)\b/i,
  /\bsed\s+-i\b/i,
  /\bgh\s+(pr|issue|release|run|api)\b/i,
  /\b(curl|wget|ssh|scp|rsync|nc|deploy)\b/i,
  // a redirect that WRITES to a file — but not `2>&1` (fd dup) or `>/dev/null`
  />>?\s*(?!&)(?!\/dev\/null\b)[\w./~$-]/,
];
function isVolatileBash(command) {
  if (!command || typeof command !== 'string') return false;
  return VOLATILE_BASH_PATTERNS.some((re) => re.test(command));
}

// The distinctive identifiers/paths in a blob — function names, file paths,
// snake/kebab/camelCase symbols, alphanumeric ids. Common English words are
// skipped (they cause false liveness matches). Used by the paraphrase-liveness
// branch: a later turn that reuses several of a dump's distinctive tokens is
// still relying on it even without quoting a line verbatim (task 1364).
function salientTokens(text) {
  const out = new Set();
  const re = /[A-Za-z0-9_$./-]{4,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.length > 64) continue; // a hash/base64 blob is not a name a paraphrase reuses
    const distinctive =
      /[_./\-$]/.test(tok) ||                       // separator: path, snake_case, kebab, member access
      /[a-z][A-Z]/.test(tok) ||                     // camelCase
      /[A-Za-z][0-9]|[0-9][A-Za-z]/.test(tok) ||    // alphanumeric mix (id123, v4, sha1)
      tok.length >= 10;                             // a long single word
    if (distinctive) out.add(tok);
  }
  return out;
}

// Normalize the raw parsed transcript (array of JSONL line-objects, each with a
// `.message`) into an ordered turn list we can index. Non-message lines (summaries,
// snapshots) are skipped but still advance nothing — only real turns count.
function normalize(transcript) {
  const turns = [];
  let turn = 0;
  for (const o of transcript || []) {
    const msg = o && o.message;
    if (!msg || !msg.role || msg.content == null) continue;
    turn += 1;
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }];
    turns.push({ turn, role: msg.role, blocks });
  }
  return turns;
}

/**
 * Classify a transcript into an eviction set + replacement stubs. Pure.
 * @param {Array<object>} transcript - parsed JSONL line-objects (each {message:{role,content}}).
 * @param {object} [options] - overrides for DEFAULTS.
 * @returns {{ evict:Array, stubs:Object, summary:object }}
 *   evict: [{ tool_use_id, turn, tool, file, tokens, reason }]
 *   stubs: { [tool_use_id]: "<one-line replacement>" }
 */
function classifyEviction(transcript, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const turns = normalize(transcript);
  const maxTurn = turns.length ? turns[turns.length - 1].turn : 0;
  const recencyCutoff = maxTurn - opt.recencyTurns;

  // Pass 1 — index tool_use blocks, edits, reads, and assistant text (for liveness).
  const toolUseById = new Map();        // id -> { name, file, query, turn, range?, volatile? }
  const editTurnsByFile = new Map();    // file -> [turns] (Edit/Write)
  const readsByFile = new Map();        // file -> [{ turn, start, end }] (Read, with line ranges)
  const assistantTexts = [];            // { turn, text } for the backward-ref liveness scan
  const toolResults = [];               // { tool_use_id, turn, tokens, text }

  for (const t of turns) {
    let textParts = [];
    for (const b of t.blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const file = targetFile(b.input);
        const entry = { name: b.name, file, query: dumpQuery(b.name, b.input), turn: t.turn };
        if (READ_TOOLS.has(b.name) && file) {
          entry.range = readRange(b.input);
          (readsByFile.get(file) || readsByFile.set(file, []).get(file)).push({ turn: t.turn, ...entry.range });
        }
        if (b.name === 'Bash') {
          entry.volatile = isVolatileBash(b.input && b.input.command);
        }
        toolUseById.set(b.id, entry);
        if (EDIT_TOOLS.has(b.name) && file) {
          (editTurnsByFile.get(file) || editTurnsByFile.set(file, []).get(file)).push(t.turn);
        }
      } else if (b.type === 'tool_result') {
        const text = blockText(b.content);
        toolResults.push({ tool_use_id: b.tool_use_id, turn: t.turn, tokens: estTokens(text), text });
      } else if (b.type === 'text' && t.role === 'assistant') {
        textParts.push(blockText(b.text));
      }
    }
    if (t.role === 'assistant' && textParts.length) {
      assistantTexts.push({ turn: t.turn, text: textParts.join('\n') });
    }
  }

  // Backward-reference liveness: a later assistant turn that is still relying on a
  // dump means we keep it. Two signals (either is enough): (a) it quotes a
  // ≥anchor-long line verbatim, or (b) it reuses ≥livenessTokenOverlap of the
  // dump's distinctive identifiers/paths — a paraphrase that re-states the dump in
  // its own words (task 1364). When in doubt we keep, so adding (b) only ever
  // protects more.
  function citedAfter(turn, text) {
    const laterTexts = assistantTexts.filter((at) => at.turn > turn);
    if (!laterTexts.length) return false;
    // (a) exact-line quote
    const anchors = String(text)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= opt.livenessAnchorChars);
    for (const at of laterTexts) {
      for (const a of anchors) {
        if (at.text.includes(a)) return true;
      }
    }
    // (b) paraphrase: distinctive-token overlap
    const dumpToks = salientTokens(text);
    if (dumpToks.size >= opt.livenessTokenOverlap) {
      for (const at of laterTexts) {
        if (!at._toks) at._toks = salientTokens(at.text);
        let shared = 0;
        for (const tk of dumpToks) {
          if (at._toks.has(tk) && (shared += 1) >= opt.livenessTokenOverlap) return true;
        }
      }
    }
    return false;
  }

  function neverEvict(text) {
    return opt.neverEvictPatterns.some((re) => re.test(text));
  }

  // Pass 2 — classify each tool_result.
  const evict = [];
  const stubs = {};
  const byReason = { superseded: 0, duplicate: 0, stale_dump: 0 };
  let toolResultTokens = 0;

  for (const r of toolResults) {
    toolResultTokens += r.tokens;
    const tu = toolUseById.get(r.tool_use_id);
    if (!tu) continue;                                  // orphan result — keep (can't reason about it)
    if (r.turn > recencyCutoff) continue;               // live working set — never evict
    if (neverEvict(r.text)) continue;                   // context-pack / worktree guidance / reminders

    let reason = null;
    if (READ_TOOLS.has(tu.name) && tu.file && tu.range) {
      const reads = readsByFile.get(tu.file) || [];
      // duplicate only when a LATER read COVERS this read's line range — a later
      // read of a different/narrower slice leaves content this read still uniquely
      // holds, so it is not a duplicate (task 1364).
      const coveredByLater = reads.some((L) => L.turn > r.turn && covers(L, tu.range));
      if (coveredByLater) {
        reason = 'duplicate';
      } else if (isFullRead(tu.range) && (editTurnsByFile.get(tu.file) || []).some((e) => e > r.turn)) {
        // superseded fires only on a WHOLE-file read: a partial read can't be
        // located relative to a (line-range-less) Edit, so a small edit must not
        // drop a disjoint slice (task 1364).
        reason = 'superseded';
      }
    } else if (DUMP_TOOLS.has(tu.name) && r.tokens >= opt.dumpMinTokens) {
      // A big, old bulk dump — evict UNLESS it's a non-reproducible/side-effectful
      // Bash run (irrecoverable → keep; task 1364) or a later turn still cites it.
      if (!tu.volatile && !citedAfter(r.turn, r.text)) reason = 'stale_dump';
    }

    if (reason) {
      evict.push({ tool_use_id: r.tool_use_id, turn: r.turn, tool: tu.name, file: tu.file || null, tokens: r.tokens, reason });
      stubs[r.tool_use_id] = stubFor(reason, tu, r.tokens);
      byReason[reason] += r.tokens;
    }
  }

  const evictTokens = evict.reduce((s, e) => s + e.tokens, 0);
  return {
    evict,
    stubs,
    summary: {
      turns: maxTurn,
      tool_result_blocks: toolResults.length,
      evict_blocks: evict.length,
      tool_result_tokens: toolResultTokens,
      evict_tokens: evictTokens,
      kept_tokens: toolResultTokens - evictTokens,
      evict_pct: toolResultTokens ? Math.round((evictTokens / toolResultTokens) * 1000) / 10 : 0,
      by_reason: byReason,
    },
  };
}

// One-line replacement for an evicted block — what stays in the prefix in its
// place. Retrieval-first (task 1350): it names what's gone + a ONE-STEP recovery
// — a file re-Read, or a concrete /recall query (search.js searchChunks) / tool
// re-run for a dump — so the agent never has to guess how to restore it.
function stubFor(reason, tu, tokens) {
  const what = tu.file ? `${tu.name} of ${tu.file}` : `${tu.name} output`;
  let recover;
  if (tu.file) recover = `re-Read ${tu.file} or /recall`;
  else if (tu.query) recover = `/recall "${tu.query}" or re-run ${tu.name}`;
  else recover = '/recall';
  const note = {
    superseded: 'file was edited after this read — content stale',
    duplicate: 'a newer read of this file exists below',
    stale_dump: 'old bulk output, not cited since',
  }[reason] || reason;
  return `[evicted ~${tokens} tok: ${what} — ${note}; recover via ${recover}]`;
}

module.exports = {
  classifyEviction,
  // exported for unit tests + reuse
  estTokens,
  blockText,
  targetFile,
  normalize,
  stubFor,
  readRange,
  isVolatileBash,
  salientTokens,
  DEFAULTS,
};
