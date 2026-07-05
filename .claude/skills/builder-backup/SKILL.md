---
name: builder-backup
description: Check the status of GDS database backups or trigger a fresh one. Use before risky changes (migrations, destructive SQL, large refactors) to ensure a recent restore point exists. Triggers when the user says "/builder-backup", "take a backup", "check backup status", "trigger a backup", "backup before migrating", or asks about the last backup.
---

You are helping the builder interact with the GDS database backup system.

## What this skill does

Runs `bongos exec scripts/gds/backup.js` (status check) or `bongos exec scripts/gds/backup.js --trigger` (fire a fresh dump + wait for it to land).

The backup infrastructure runs on the production droplet:
- **Nightly local dump** — `pg_dump` to `/var/backups/gds/` as `<db>-<timestamp>.sql.gz`, 30-day retention (task [#412](https://amazonprimea.com/builders#/task/412))
- **Weekly offsite copy** — latest local dump uploaded to DigitalOcean Spaces, 4-week retention (task [#415](https://amazonprimea.com/builders#/task/415), ADR 0025)

This skill lets a Metic+ builder check on backups and take a fresh one — no SSH, no systemctl, no server access.

## When to use

- **Before a risky change** — before running a DB migration, writing destructive SQL, or shipping a large schema change. `--trigger` gives you a restore point dated seconds ago instead of up to ~24 hours ago (nightly window).
- **Restore readiness check** — after a trigger, confirm the dump landed and looks sane (filename, size, timestamp) before proceeding.

## How to use

### Check status (no action, just info)

```bash
bongos exec scripts/gds/backup.js
```

Outputs the latest dump filename, timestamp, size, and count of retained dumps.

### Trigger a fresh backup

```bash
bongos exec scripts/gds/backup.js --trigger
```

Fires a fresh local dump on the server. Polls until the new dump lands (up to ~60 s) and prints its details on success.

## Rank gate

Both commands require **Metic or Archon** rank. The server enforces this per-request.

## Restore

If you need to restore from a backup, follow the restore drill in `docs/recipes/gds-db-backup.md`. Restore is a destructive Archon-only operation — do NOT attempt it without Lars's explicit sign-off.

## After using this skill

If you triggered a backup before a migration:
1. Confirm the new dump landed (skill prints this on success).
2. Note the dump filename in your session log so the restore point is traceable.
3. Proceed with the risky operation.
