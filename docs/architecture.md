# Capture loop

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 3
**Repo:** braintied/watchtower
**What this is:** How the public Apache snapshot is wired

```
agent on their machine
        |
        v
Stop / SessionStart hook   or   disk adapter (Grok / Codex / Cursor / OpenCode)
        |
        v
POST http://localhost:5003/webhooks/session
        |
        v
their Hono server (src/index.ts)
        |
        v
their Postgres (migrations/001_init.sql)
```

The full contract (adapters, session keys, slug ladder, webhook
payload, env, traps) lives in [README.md](../README.md) and
[AGENTS.md](../AGENTS.md).

| Piece | Runs on | Writes code? |
|-------|---------|--------------|
| This snapshot | their machine | No |
| Their webhook server | their laptop or their host | No |
| Their Postgres | their laptop or their host | No |
| `ora-watchtower.fly.dev` | Braintied | No, and the hook refuses it |

`src/index.ts` is the leftover local server. Sync does not overwrite
it. Its webhook `source` enum matches `CODING_SESSION_SOURCES` in
`src/types.ts`.
