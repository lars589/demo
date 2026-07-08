---
name: builder-exit
description: Gracefully offboard (or reactivate) a builder. Deactivating releases their active claims, seals each with a final session log, drops their rank to the sandboxed Xenos tier, blocks them from claiming new work, and archives their local memory — all while preserving their drachmae, credit history, and shipped-task attribution indefinitely. Triggers when the user says "/builder-exit N", "offboard builder N", "builder X is leaving", "deactivate builder", or "reactivate builder N". Archon-only — the offboard endpoint is Archon-gated. If a non-Archon, or anyone who just wants to end their own session, invokes it, redirect them to /builder-end (the session close-out) instead of dead-ending on a 403.
---

**Script skill (authoritative).** The core action is the `PATCH /api/gds/builders/:id/status` API call via `cli-lib.js`. Once intent is confirmed, run it and print the response verbatim — do not summarize or editorialize the claims-released list.

You are gracefully offboarding a builder from the Game Development System, or reactivating one who has returned. This is a robustness operation — what happens when someone quits — and it must be **lossless**: nothing the builder earned or shipped is ever deleted.

## First: is this an offboarding, or do you just want to close out your session?

`/builder-exit` is **not** how you end a working session. It permanently **offboards an entire builder** — an Archon deactivating *someone else's* account (releases all their claims, drops them to Xenos, blocks new claims). "Exit" is the natural word for "log me off," so builders reach for this first ([#1448](https://demo.cloudbongos.com/builders#/task/1448)) — but it's the wrong, and gated, tool for the everyday close-out. Before touching anything, check intent:

- **The caller wants to wrap up their *own* online-terminal / Claude Code session** — no builder id given, the id is their own, or they said "close out / end / sign off / I'm done" → **do not attempt an offboard.** Say plainly: *"`/builder-exit` offboards an entire builder (releases all their claims, drops them to Xenos) and is Archon-only — it isn't the session close-out. To close out your session, run **`/builder-end`**: it resolves your claim (ship or release) and, on a dev box, offers to shut the box down with `close-box`."* Then stop and hand off to `/builder-end`.
- **The caller is not an Archon** (rank below `archon`, or you can't confirm Archon) → same redirect. The endpoint would 403 (`rank_forbidden`) anyway; don't dead-end them on the error — point them at `/builder-end` (+ `close-box` on a box).
- **An Archon is deliberately offboarding (or reactivating) *another* builder, by id** → this is the real operation. Proceed with the steps below.

Never run the destructive offboard just because someone wanted to log off — the two are different operations.

## What graceful exit does (V3.R88 #307)

Deactivating a builder via `PATCH /api/gds/builders/:id/status { status: 'inactive', reason }` transactionally:

1. **Releases every active claim** they hold (`released_at = now`, outcome `abandoned`) and bounces each in-flight task back to `ready` so the work isn't stranded.
2. **Seals an outstanding session log** for each released claim (a closing `abandoned`-on-exit row — the audit trail shows the work was handed back, not silently dropped).
3. **Drops their rank to `xenos`** (the sandboxed tier) and sets `status = 'inactive'`, which **blocks them from claiming any new task** (the claim path refuses with `BUILDER_INACTIVE`).
4. **Preserves everything else**: drachmae (`total_credits`), the full `credit_log`, their shipped tasks, and historical session logs all stay, attributed to them, indefinitely.
5. Writes an interim audit row to `credit_log` (`delta=0`, reason carries the actor) until the dedicated `audit_log` lands (R36).

Reactivation (`{ status: 'active' }`) flips them back to active. **Rank is not auto-restored** — it stays `xenos`, and an Archon re-promotes deliberately via `/builder-exit`'s sibling rank endpoint (`PATCH /api/gds/builders/:id/rank`).

## Authority

**Archon-only.** The endpoint is guarded by `requireRank('archon')` server-side (ADR 0016). An Archon **cannot change their own status** (`cannot_change_own_status` — the same no-last-Archon-footgun guard as rank changes), so the system can never be left with nobody in charge.

## Memory archival (local-first)

A builder's memory is **local-first**: it lives in their own `~/.claude/projects/<project>/memory/` on their own machine. The server never holds another builder's local memory (the server-side per-builder memory store is criterion #54's separate task).

So memory archival is a **local** step, done on the exiting builder's machine — archived, never deleted:

1. If you are running this on the **exiting builder's own machine**, move (don't delete) their memory dir into a dated archive:
   ```bash
   MEM="$HOME/.claude/projects/<project-slug>/memory"
   if [ -d "$MEM" ]; then
     mkdir -p "$MEM-archive"
     cp -R "$MEM" "$MEM-archive/$(date +%Y-%m-%d)-exit" && echo "memory archived to $MEM-archive"
   fi
   ```
   Keep the original in place too if the builder might return soon — archival is a snapshot, not a wipe. If they're fully leaving the machine, the archive copy is the durable record.
2. If you are an **Archon offboarding someone remotely**, you cannot reach their local memory — note in the exit reason that local-memory archival is the departing builder's responsibility (or deferred to the #54 server sync once it exists). The server-side deactivation (steps 1–5 above) still runs and is the authoritative record.

## How to use

1. **Resolve the target builder id.** `/builder-exit 5` → builder #5. If given a name/login, look it up via the leaderboard or `GET /api/gds/me` patterns. Confirm the right person with the user.

2. **Confirm intent.** Offboarding is significant and Archon-gated — restate what will happen ("this releases their N active claims, drops them to Xenos, and blocks new claims; their credits and shipped work are preserved") and get a clear go-ahead.

3. **Archive local memory** if on the exiting builder's machine (see above).

4. **Call the endpoint** (uses the current Archon's session token):
   ```bash
   # Deactivate
   node -e "require('./scripts/gds/cli-lib.js').apiCall('PATCH','/api/gds/builders/<id>/status',{status:'inactive',reason:'<why>'}).then(r=>console.log(r.status, JSON.stringify(r.data,null,2)))"
   # Reactivate
   node -e "require('./scripts/gds/cli-lib.js').apiCall('PATCH','/api/gds/builders/<id>/status',{status:'active'}).then(r=>console.log(r.status, JSON.stringify(r.data,null,2)))"
   ```

5. **Print the API response verbatim.** The JSON shows claims released and new rank/status. If reactivating, note (from the response) that rank stays `xenos` until a `/builder-rank` promotion.

## Error modes

- `403 rank_forbidden` — you're not Archon. Only an Archon can offboard.
- `403 cannot_change_own_status` — you tried to deactivate yourself. Another Archon must do it (last-Archon guard).
- `409 already_inactive` / `409 not_inactive` — the builder is already in the target state.
- `404 builder_not_found` — wrong id.

## Constraints

- **Never delete a builder row or their credit/credit_log/session_logs.** Exit is deactivation, not deletion. The whole point is that history survives.
- **Never archive by deleting local memory.** Copy to the archive; the builder may return.
- **Don't offboard reflexively.** A builder who's just idle isn't gone — exit is for genuine departures.

## Files this skill touches

- Reads: `~/.config/cloudbongos/gds-session.json`, the exiting builder's local memory dir
- Writes: `<memory>-archive/` (local snapshot, on the builder's machine)
- Calls: `PATCH /api/gds/builders/:id/status`
