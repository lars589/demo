---
name: builder-redteam
description: File a red-team / vulnerability report against the city. Walks the builder through severity, target, title, repro, expected vs. actual, then POSTs to /api/gds/security/reports so the Archon view picks it up. Optionally drafts a follow-up idea_inbox entry for the fix. Triggers when the user says "/builder-redteam", "I found a security issue", "redteam report", "file a vuln", or describes a flaw in the system's own walls. Metic+ only — Xenos see a polite refusal.
---

You are filing a vulnerability report on the Off the Boats project. The reporter is a trusted builder who has found a flaw — in the GDS, the game server, the chat broadcast, the deploy chain, the auth model — and wants the red-team bounty surface to pick it up.

This is the **bounty intake** side of V3.R63/R64/R67. Once the report is filed:

- it lands in `vulnerability_reports.status='open'`;
- the Archon view at `/builders` (R67) surfaces it for adjudication;
- the auto-repro subagent (V3.R68, when live) will attempt to reproduce it;
- if confirmed, the city pays out drachmae by severity.

The reporter does NOT need Archon attention to file. The Archon comes to the queue, not the other way around.

## Hard rules

- **Metic+ only.** Xenos rank gets a 403 from the API. If you're a Xenos, the polite refusal tells you to ask the Archon to escalate or to flag the flaw through normal chat channels.
- **Don't file against people.** Reports are about *flaws*, not behavior. If the issue is "Lars said X in chat," this is the wrong surface.
- **Don't file duplicates.** The Archon view already deduplicates by target+title at adjudication time, but be a good citizen — search recent reports first if you suspect overlap.
- **Don't include live secrets in the description.** The `repro_steps_md` field is captured verbatim; if your repro requires a token, refer to it as `<TOKEN>` and put the real value in a separate channel (Signal, in-person).

## What this skill does

1. Reads `~/.config/cloudbongos/gds-session.json` for the bearer token.
2. Hits `GET /api/gds/me` to confirm rank ≥ Metic. Refuses with a friendly message if Xenos.
3. Walks the user through five questions (see below).
4. POSTs to `/api/gds/security/reports`.
5. Echoes the report id back + a note that the auto-repro subagent will attempt reproduction within the hour.
6. (Optional) Offers to file an `idea_inbox` entry with `kind='security-finding'` pointing back at the report id, so the fix can be triaged into a normal task on the next `/idea-triage` pass.

## The five questions

Ask one at a time. Don't batch — the answers feed each other.

1. **Severity.** One of `low`, `medium`, `high`, `critical`. Show the bounty schedule from `GET /api/gds/public/bounty-table` if the user is unsure. Critical means "this could let an attacker forge writes as another builder or read data they're not entitled to"; high means a real attack vector with a workaround; medium is a defense-in-depth gap; low is a hardening recommendation.
2. **Target.** One short line — the route, file, endpoint, or surface. Examples: `POST /api/gds/tasks/:id/override-request`, `src/bongos/auth.js#verifyToken`, `caddy: demo.cloudbongos.com:443`. Goes into the `target` column verbatim.
3. **Title.** One sentence summarizing the flaw. Reads in the Archon queue first, so make it scan-friendly. Example: "OAuth state cookie has no SameSite=strict — CSRF window during auth handshake."
4. **Description.** What's the impact? Who would notice? Why does it matter? A few sentences. Free-form Markdown.
5. **Repro steps.** Numbered list of what an attacker (or auditor) does to demonstrate the issue. The auto-repro subagent (R68, when wired) will try to follow these exactly, so be precise. Use `<TOKEN>` or `<COOKIE>` placeholders for any sensitive values.

After each answer, echo it back. If the user changes their mind, accept the revision before moving on.

## POST shape

Build the report JSON from the five answers above, write it to a temp file with
your file-write tool (NOT a shell heredoc — heredocs aren't portable), then POST
it with the cross-platform GDS API helper:

```
bongos exec scripts/gds/api.js POST /api/gds/security/reports --body-file <path-to-report.json>
```

where `report.json` is:

```json
{ "target": "<TARGET>", "severity": "<SEVERITY>", "title": "<TITLE>", "description": "<DESCRIPTION>", "repro_steps_md": "<REPRO>" }
```

`api.js` resolves your session token + API base via `cli-lib` (no manual token
extraction) and runs on Windows/macOS/Linux — the old `jq` + `curl` form did not.

Expected response: `201 { ok: true, report: { id, status: 'open', ... }, bounty_table: { ... } }`.

If the response is `403 rank_forbidden`, surface the message — the user is Xenos and should not have reached this step.

## Confirmation message

After a successful filing, tell the user:

```
Report #<id> filed at severity=<sev>, status=open.
Visible now in /builders → Watch of the City (Archon view).
Bounty if confirmed: <drachmae> (see /public/bounty-table).
An automated subagent will attempt to reproduce within the hour (R68);
the Archon will adjudicate after that.
```

## Optional follow-up: idea_inbox entry

After the report is filed, offer:

> "Want me to also file an `idea_inbox` entry for the *fix*? That puts the work into the normal triage queue so the next `/idea-triage` pass can promote it to a real task."

If yes — write the idea JSON to a temp file, then:

```
bongos exec scripts/gds/api.js POST /api/gds/inbox --body-file <path-to-idea.json>
```

where `idea.json` is:

```json
{ "title": "Fix: <TITLE>", "body_md": "Originates from vulnerability_report #<REPORT_ID> (severity=<SEVERITY>). Target: <TARGET>.\n\n<DESCRIPTION>", "kind": "security-finding" }
```

This is optional because some findings are "the system is fine, my mental model was wrong" — the report itself is the durable signal; an idea entry is only useful when there's actual remediation work to schedule.

## What this skill does NOT do

- Does NOT post anything to the team chat space — the bounty surface is intentionally Archon-private until adjudicated.
- Does NOT create a `tasks` row directly — a vuln routes through the security-report surface (`/security/reports`) and the optional idea_inbox path above, which then becomes a fix-task via `/idea-triage`. (Authoring a task is Metic+ as of [ADR 0090](../../../docs/adr/0090-metic-task-authoring.md), but red-team reports deliberately use the report/idea flow, not a self-authored task.)
- Does NOT ping the Archon. The Archon view auto-refreshes; pinging would defeat the queue's batching purpose.
- Does NOT score or grade the report. That's R68 (auto-repro) + Archon adjudication.

## When the API is unreachable

If the POST fails (network, droplet down, route 5xx), do NOT silently swallow. Print the full response body and tell the user the report was NOT filed. Offer to re-try once they confirm the droplet is up — `bongos exec scripts/gds/api.js GET /api/gds/healthz` is the fastest probe (cross-platform; prints the status).
