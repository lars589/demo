---
name: new-project
description: The agent-guided runbook that takes a new owner from zero to a live, owned STANDALONE Cloud Bongos instance (own repo + pinned @cloudbongos/core, ADR 0108) through ONE canonical step sequence — decide name+address, bongos init, scaffold the standalone repo, provision core+DB+address+service, GitHub OAuth app + verified secret + first sign-in, verify, brand. Triggers when the user says "/new-project", "start a new project", "stand up a new instance", "onboard a new Cloud Bongos instance", "create a new project", or "spin up a new instance". This skill IS the canonical sequence; the `bongos onboard` CLI (task 1982) and the hall "start a project" wizard (task 1983) are forms over it. Standalone model only.
---

You are guiding a new owner from **zero to a live, owned Cloud Bongos instance**. This skill is the **canonical step sequence** (goal 35). The `bongos onboard` CLI and the hall wizard are just other front-ends over these same steps — keep them in lockstep by keeping the sequence here.

## The model (read first)

A new instance is **standalone** (ADR 0108): it runs from its **own git repo** with `@cloudbongos/core` installed as a **pinned npm dependency**, not a fork of this monorepo. Central updates are a `bongos upgrade` version-pin bump, not a merge. Every step below assumes this shape (`hosting_shape=standalone`).

Four steps are **irreducibly human** and must be rendered as **precise, UI-first, copy-paste-safe prompts** (a non-technical owner does them with browser clicks, no terminal guessing): (1) create the GitHub repo, (2) create the GitHub OAuth app + secret, (3) own a domain, (4) the first sign-in. Everything else is automated. Never ask the owner to do in a terminal what they can do with a click.

## The canonical sequence

### 1. Decide name + address

Interview the owner for: product name, world name, company; the **GitHub repo** (`owner/name`); the **domain** they will use (bring-your-own — ADR 0111 §4); and a DNS/db-safe **instance slug** (lowercase `[a-z0-9-]`, e.g. `mercury`).

**Human-only (UI-first):** have them create an **empty** GitHub repository — github.com → **New repository** → name it, leave it empty (no README), Create. That repo is where the instance's own code will live.

### 2. DNS token preflight — BEFORE you commit the address (task 1980)

Before anything is provisioned, verify the control-plane's Cloudflare token can actually manage the domain's zone (a mismatched-zone token is exactly what broke the Emersonian standup mid-flow):

```bash
bongos exec scripts/gds/provision.js dns-check <domain>
```

- ✓ reachable → continue.
- ✗ not reachable → **STOP and resolve it now**, don't push past it. The command prints the fix; usually: widen the Cloudflare API token to include the domain's zone (CF dashboard → My Profile → API Tokens → edit → Zone Resources → Include → the zone), then re-run `dns-check` until green. Only then proceed.

### 3. `bongos init` — scaffold (greenfield) **or** `--adopt` (brownfield)

**This is the one leg that branches** (ADR 0121 §Decision 1). Pick the mode that matches the repo:

- **Greenfield** — a NEW, empty repo. The default below.
- **Brownfield / adopt** — an EXISTING repo (code, history, a backlog). Run `node bin/bongos.js init --adopt` instead. It DETECTS the repo's stack, runs a conflict **pre-flight** (migration-namespace / fitness-boundary / protected-path / CI-check collisions) and writes **nothing until you accept** (interactive y/N, or `--accept`); a genuine BLOCK (e.g. a `core_`-prefixed migration) is a hard stop, not accept-able. On accept it LAYERS the lean config + the pinned `@cloudbongos/core` dep + `.claude/` **additively** (merges-or-leaves-and-reports; never clobbers, never the `--force` path), captures the repo's **REAL** current version/goal, and imports its existing backlog (open GitHub issues via `GITHUB_TOKEN`/`GH_TOKEN`, else a `TODO`/`ROADMAP`/`BACKLOG` file). Then **skip step 4** — adopt layered onto the existing repo, there is no empty repo to scaffold — and continue from step 5 (provision). Every other leg is identical.

Greenfield:

```bash
node bin/bongos.js init          # interview (or: init --from spec.json for non-interactive)
```

It writes lean `config/branding.json` / `config/modules.json` / `config/hierarchy.json`, seeds the first version + its done-when goal, files the human-only kickoff tasks, and — when you opt into hosting — files a **provisioning request** (`POST /provisioning/instances`). Choose **hosting shape `standalone`**. Enable the `provisioning` module on the target so the request is honored (`config/modules.json` → `"provisioning": true`).

### 4. Scaffold the standalone repo

Materialize the instance's own repo (ADR 0108): clone the empty GitHub repo to the standalone root (`${PROVISION_STANDALONE_BASE:-/srv/cloudbongos}/<slug>` on the control plane), drop in the `config/` + `.claude/` from step 3, and pin the core as a dependency (`@cloudbongos/core` in the instance `package.json`). Commit + push. This checkout is what the standalone service will run from.

### 5. Provision — core + DB + address + service (task 1978)

The web tier only **enqueued** the request; the **control-plane runner** does the real work (it alone holds the DO/Cloudflare tokens):

```bash
bongos exec scripts/gds/provision.js run-intents --apply     # drains the queue
# or, for one instance:  bongos exec scripts/gds/provision.js provision <slug> --apply
```

For `standalone` this composes: allocate a port → `git pull` + `npm ci --omit=dev` (installs the pinned core) → `createdb` + **instance-root** migrate (`node_modules/@cloudbongos/core/scripts/migrate.sh`) → per-instance `/etc/<slug>/web.env` → a **standalone systemd unit** (runs the core package's `platform-server.js` from the instance repo) → DNS A-record UPSERT → per-instance Caddy snippet (on-demand TLS) → `/healthz`. It is idempotent + dry-run-by-default (omit `--apply` to preview). It **fail-fasts on the step-2 DNS preflight** if step 2's token check was skipped.

### 6. GitHub OAuth app + verified secret + first sign-in

**Human-only (UI-first) — create the OAuth app.** GitHub → **your account's** Settings → **Developer settings** → **OAuth Apps** → **New OAuth App**.
> **Guidance the standup learned:** *Developer settings is under your **account**, not the repository* — this is the #1 place owners get stuck.
- **Homepage URL:** `https://<domain>`
- **Authorization callback URL:** `https://<domain>/api/gds/auth/web/callback` (PINNED — `auth.js` `WEB_REDIRECT_ORIGIN`; a sign-in begun on a `builders.` subdomain still calls back to the apex).
- Copy the **Client ID**; click **Generate a new client secret** and copy it (GitHub shows it **once**).

**Place the secret — VERIFIED, never by hand (task 1979):**

```bash
bongos exec scripts/gds/oauth-secret.js place <slug> --client-id <id> --client-secret <secret> --apply
```

> **Guidance the standup learned:** do **NOT** hand-edit `web.env` with a shell `read -s` — during the Emersonian standup that silently left a 26-char truncated secret that broke sign-in with no obvious cause. `oauth-secret` validates the length/format (catching that truncation), rewrites the env line via Node, restarts the service, then **probes `/healthz` for `auth_configured:true`** before it reports success. If it refuses, the creds are wrong — recheck them; do not proceed.

**Human-only — first sign-in.** The owner opens `https://<domain>` and signs in with GitHub **once**. This seats the **founding Archon** — config alone seats no one, so this step is inherent and cannot be automated.

### 7. Verify

```bash
curl -s https://<domain>/healthz          # → {"ok":true,"auth_configured":true}
```

Confirm the owner is **Archon** (their profile / the hall roster). If `auth_configured` is `false`, re-run the `oauth-secret place` step and recheck the OAuth app values.

### 8. Brand

Fill the instance **look** — theme / palette / fonts in `config/branding.json` (see `docs/branding-fill-prompt.md`). The identity strings were set at init; this is the visual layer. "Brand with your own LLM."

## Done-when

A new owner has gone zero → live: their own standalone repo on a pinned core, provisioned with no hand-editing of servers, the four human-only steps done UI-first + verified, and they are signed in as the founding Archon on their own domain. That is goal 35's `project-creation-flow` criterion.

## Constraints

- **This skill is the source of truth for the sequence.** If a step changes, change it here; `bongos onboard` (task 1982) and the hall wizard (task 1983) must render the same sequence.
- **Standalone only** (ADR 0108) — do not fall back to editing this monorepo's checkout for a new project.
- **Never weaken the trust boundary** — the web tier enqueues; only the control-plane runner (`provision.js`) touches cloud tokens (ADR 0016 / 0111 §2).
- **Adopting an EXISTING repo** (brownfield) is the other branch of the scaffold leg (step 3) — `bongos init --adopt` ([ADR 0121](../../../docs/adr/0121-greenfield-vs-brownfield-onboarding-adopt-existing-repo.md)): detect → accept-gated conflict pre-flight → additive layering (never clobbers) → real version/goal + backlog import. Built; the `bongos onboard` CLI and the hall "start a project" wizard offer the same greenfield-vs-adopt choice.
