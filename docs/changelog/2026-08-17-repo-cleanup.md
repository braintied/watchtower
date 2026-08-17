**Date:** 2026-08-17 (PT)
**Repo/branch:** braintied/watchtower · main
**What this is:** Public repo root cleanup

Removed harness scaffolding that does not belong on an Apache capture
client: `qa/` template, `docs/plans/`, changelog TEMPLATE,
DOC-GOVERNANCE, `check-fleet-guards.mjs` (140k of fleet policy),
doc-link and CLAUDE.md size checkers. Deleted on-disk `.omc/`.
Dropped the `backfill` script that pointed at a missing file.
Installer paths are `scripts/install-hooks.ts`, not
`scripts/watchtower/…`. Webhook `source` enum now matches
`CODING_SESSION_SOURCES` so a Grok POST to the self-host server
does not 400.

51 tracked files → 44.
