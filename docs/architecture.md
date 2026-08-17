# Watchtower capture client

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 2
**Repo:** braintied/watchtower
**What this is:** How the public Apache snapshot is wired

The full contract (adapters, session keys, slug ladder, webhook
payload, leftover 2026-03 enum, env, traps) lives in
[README.md](../README.md) and [AGENTS.md](../AGENTS.md). This page
is the topology only.

| Piece | Runs on | Writes code? |
|-------|---------|--------------|
| This snapshot | your machine | No |
| `@braintied/watchtower` | any Braintied Mac | No |
| Hosted indexer (Fly hostname `ora-watchtower`) | `ora-watchtower.fly.dev` | No |
| Runner pool | a Mac, launchd | Yes |

Synced from `braintied/stack` `packages/watchtower/oss/` by
`scripts/sync-oss.mjs`. The leftover Hono server in `src/index.ts`
is not overwritten and still rejects `source=grok`.
