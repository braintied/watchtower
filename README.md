# Watchtower

**Created:** 2026-03-30 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 5.0.1

Public Apache capture client, synced from `@braintied/watchtower` 5.0.1
on every package publish. This is the hooks + adapters + self-host server.

Floor, board, manage, runner brains, and Cortex privileged REST writers are
**not** in this repo. They stay in the proprietary stack package.

## Install

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
npm run install-hooks
```

Point hooks at a Watchtower webhook (default `http://localhost:5003/webhooks/session`):

```bash
export WATCHTOWER_SESSION_WEBHOOK_URL=https://your-host/webhooks/session
```

Grok, Codex, Cursor, and OpenCode sessions are ingested by the adapters in
`src/session-adapters.ts` (same files as the fleet package).

## What is synced

- `src/session-adapters.ts`, `src/project-slug.ts`, `src/types.ts`
- `hooks/lib/session-key.sh`, `hooks/lib/project-slug.sh`
- webhook-only `hooks/session-ingest.sh` (no Cortex keys)

## What is not

| Stays proprietary | Where |
|---|---|
| Floor, board, manage | `stack/packages/watchtower` |
| Cortex service-role hooks | same |
| Fly indexer | `ora-ai/apps/watchtower` |

## License

Apache-2.0. The fleet package `@braintied/watchtower` is proprietary.
