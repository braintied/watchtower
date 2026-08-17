# Capture loop

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 4
**Repo:** braintied/watchtower
**What this is:** How the public Apache snapshot is wired

```
agent on their machine (any model)
        |
        v
Stop / SessionStart hook   or   disk adapter
        |
        v
POST http://localhost:5003/webhooks/session
        |
        v
their Hono server (src/index.ts)
        |
        v
their PostgREST  -->  their Postgres (migrations/001_init.sql)
```

Capture does not call a model. Optional leftover jobs go through
local Inngest on port 8288.

The full contract and a plain-language page for every named
service (Postgres, PostgREST, the `SUPABASE_` names, Inngest,
Fly.io) live in [README.md](../README.md). Agents:
[AGENTS.md](../AGENTS.md).

| Piece | Runs on | Writes code? | Needs an account? |
|-------|---------|--------------|-------------------|
| This snapshot | their machine | No | No |
| Their webhook server | their laptop or their host | No | No |
| Their Postgres + PostgREST | compose, or a host they pick | No | No |
| Local Inngest | compose port 8288 | No | No |
| Fly.io / Render / a VM | only if they want a public URL | No | Only if they pick that host |
| `ora-watchtower.fly.dev` | Braintied | No | Never. The hook refuses it |

`src/index.ts` is the leftover local server. Sync does not overwrite
it. Its webhook `source` enum matches `CODING_SESSION_SOURCES` in
`src/types.ts`.
