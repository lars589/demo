---
name: recall
description: One-call project-knowledge search across the repo docs + DB prose (tasks, learnings, session logs). Triggers when the user says "/recall", "recall …", "what do we know about X", "have we done X before", "did a past session hit X", "search the docs/ADRs for X", "is there an ADR about X", or before re-solving something that smells already-solved. Read-only; rank-scoped server-side. Run it instead of grepping the tree or asking the user to remember.
---

You are answering "what do we already know about X?" — the GDS-V4 one-call-recall capability ([ADR 0060](../../../docs/adr/0060-gds-retrieval-layer.md)). Before this existed, recall meant grepping the repo + eyeballing session logs + hoping you remembered the right ADR. Now one call searches the indexed corpus (every repo markdown + nightly-indexed DB prose: task descriptions, learnings, session-log summaries, recent shipped-task summaries) with full-text + typo-tolerant fuzzy matching fused by RRF, and returns the most relevant sections with their breadcrumb (file > heading > subheading).

## Two-step flow: summary first, then expand (progressive disclosure)

Recall uses **progressive disclosure with token-cost visibility** ([ADR 0095](../../../docs/adr/0095-cross-agent-context-management.md) C1). You don't pay for the full corpus in one shot:

1. **Step 1 — the summary layer.** `recall <query>` returns a *ranked, compact* list: each hit is a title, breadcrumb, snippet, and a **token-cost label** — `~N tok` is what a full read of that hit would cost, and a `~N tokens to expand all` headline totals the whole result set. You see what a deeper read will COST before you pay for it.
2. **Step 2 — expand the one you want.** `recall --expand <id>` fetches just that hit's full content (the id is the `#NNN` printed at the head of each result line). Spend tokens only on the hit that actually answers the question — typically one, not all ten.

So the loop is: search → read the cheap summaries + costs → expand the single best hit (or open its `source_ref` directly). A `→ recall --expand <id>` hint prints under any hit whose snippet is only a preview of a larger section.

## When to reach for it (liberally)

- The user asks about a past decision, a footgun, an ADR, "how does X work", or "have we done X."
- You're about to design or build something that might already be solved — search first (the "romantic-gauss redundant-work" case: a parallel/past session may have already fixed it).
- You need the canonical doc for a topic and don't know its exact path.

## How to use

```bash
bongos recall <query…>            # STEP 1: ranked summary + per-hit token cost; query is the rest of the line, quotes optional
bongos recall trust boundary
bongos recall "grader bypass" --limit 5
bongos recall nightly backup --kind doc     # restrict to docs (vs --kind db for DB prose)
bongos recall --expand 1234       # STEP 2: full content of hit #1234
bongos recall <query…> --json     # raw JSON for further processing
```

Each summary result shows the hit id (`#NNN`, the handle for `--expand`), the title, the breadcrumb (`file > H1 > H2`), the source ref, a relevance score, which legs matched (`fts+trgm`), a snippet, and the **token cost** to expand it. Either `recall --expand <id>` for the full section in-band, or open the cited `source_ref` directly.

## What to do with results

- **Read the summary layer first; expand sparingly.** The whole point of step 1 is to spend almost no tokens deciding *which* hit is worth a full read. Look at the snippets + costs, then `--expand` (or open `source_ref` for) the one or two that actually answer the question — don't expand all of them.
- **Relay the relevant ones**, each with its `source_ref` so the user (and you) can open the exact section — don't dump all of them; pick what answers the question.
- If recall surfaces an existing ADR / task / learning that already covers the work, **say so and link it** rather than re-deriving — that's the whole point.
- If `No matches`, the topic may be unindexed (a brand-new doc indexes on the next deploy; DB prose indexes nightly). Fall back to a targeted grep / `/status` only then.

## Constraints

- **Read-only + rank-scoped.** Results are filtered server-side to your live rank + your own private chunks ([ADR 0060](../../../docs/adr/0060-gds-retrieval-layer.md) §6 / [ADR 0016](../../../docs/adr/0016-trust-boundary-server-enforced-permissions.md)) — a sub-Metic session will not see permission-core docs, and you never see another builder's private memory. Don't try to widen scope via flags; there's no such flag.
- **Authenticated.** Recall searches *as you*, so it needs a builder session (`/builder-setup` once). A 401 means "sign in first."
- Don't paste the raw JSON at the user unless they ask — summarize + cite.

## Files this skill touches

- Calls: `POST /api/gds/search` via `scripts/gds/recall.js` — twice over the same route: `{ q }` for the summary layer (step 1) and `{ expand: <id> }` for one hit's full content (step 2).
- Reads: `~/.config/cloudbongos/gds-session.json` (the session token, like every `/builder-*` CLI).
