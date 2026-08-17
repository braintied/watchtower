# Watchtower capture client

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 1
**Repo:** braintied/watchtower
**What this is:** How the public Apache snapshot is wired

Watchtower is Braintied's session intelligence. This repository is the
open capture client only.

## Topology

| Piece | Runs on | Writes code? |
|-------|---------|--------------|
| This snapshot (hooks + adapters + self-host server) | your machine | No |
| `@braintied/watchtower` | any Braintied Mac | No |
| Hosted indexer (Fly app name `ora-watchtower`) | `ora-watchtower.fly.dev` | No |
| Runner pool | a Mac, launchd | Yes |

`ora-watchtower` is the Fly hostname. The product is Watchtower.

## Capture path

1. Claude Code Stop runs `hooks/session-ingest.sh` and POSTs the
   session to `WATCHTOWER_SESSION_WEBHOOK_URL` (default
   `http://localhost:5003/webhooks/session`).
2. Grok, Codex, Cursor, and OpenCode land through
   `src/session-adapters.ts` and `watchtower ingest` in the fleet
   package.
3. Session keys are `grok:<id>` and `claude:<id>`
   (`hooks/lib/session-key.sh`).

Floor, board, manage, recall, journeys, and error fingerprints live in
the Braintied package and the hosted indexer. They are not in this tree.

## Sync

`node packages/watchtower/scripts/sync-oss.mjs --apply` in
`braintied/stack` overwrites the capture files, `README.md`, and
`AGENTS.md`. Version numbers stay locked to `@braintied/watchtower`.
