---
name: builder-cost
description: Log a cost entry to the GDS — API spend, infra cost, art-pipeline credits, etc. Triggers when the user says "/builder-cost", "log cost", "I just spent X on Y", or after a session that consumed billable credits. Categories are api | compute | infra | domain | art | other.
---

**Script skill (authoritative).** The core action is `bongos cost <amount-usd> <category> [--task-id N] [--description "..."] [--skill <name>]`. Once the args are determined, run it and print its output verbatim.

You are logging a cost entry on behalf of the current builder. The GDS keeps a running ledger that powers the cost-vs-value charts on `demo.cloudbongos.com`.

## What this skill does

Runs `bongos cost <amount-usd> <category> [--task-id N] [--description "..."] [--source "..."] [--skill <name>]`.

The CLI hits `POST /api/gds/cost`, which inserts a `cost_log` row.

## How to use

1. **Determine the amount in USD.** Round to four decimals (the column accepts numeric(10,4)). For Anthropic API spend, use the API response's `usage` block × the model's pricing.

2. **Pick a category**:
   - `api` — Anthropic API, Google AI Studio, GitHub paid features, etc.
   - `compute` — droplet upgrades, ad-hoc cloud spend
   - `infra` — backups, monitoring, CDN paid plans
   - `domain` — Cloudflare Registrar renewals
   - `art` — direct art commissions or stock-asset purchases
   - `other` — when none fit, with a clear description

3. **Attach to a task if one applies** — `--task-id <N>`. This is what makes the cost-vs-value chart per-task accurate.

4. **Attach to a skill if this cost was incurred by a skill invocation** — `--skill <skill-name>` (e.g. `--skill idea-triage`). This populates the `skill_name` column for per-skill spend measurement (ADR #304).

5. **Run** and print the output verbatim:
   ```bash
   bongos cost 0.42 api --task-id 12 --description "Anthropic API: 4.2k input + 1.1k output"
   ```

## Constraints

- **Don't log speculative cost.** Only log spend that has actually been incurred (or is committed and irreversible).
- **Don't log Lars's personal time** — credits are how that's accounted for, not USD.
- **Don't double-count.** Before logging an art-pipeline cost manually, verify it isn't already in the DB from the one-time cost-ledger backfill (those rows use `source: 'art-cost-ledger'`).
- **Don't log without a description for `other` category.**

## Files this skill touches

- Reads: `~/.config/cloudbongos/gds-session.json`
- Calls: `POST /api/gds/cost`
