# Contributing

This repository is the public Apache-2.0 capture client for
Watchtower. Open issues and pull requests here.

| Change | Where it lands |
|--------|----------------|
| Adapters, session-key, project-slug, types | `src/` in this repo |
| Webhook-only Stop hook | `hooks/session-ingest.sh` |
| Docs for humans | `README.md` |
| Docs for agents | `AGENTS.md` |

This tree is also generated from a private package. An accepted PR
is folded back into that package and re-synced, so the next
snapshot includes it. You do not need access to the private package
to contribute.

Do not add a connection to `ora-watchtower.fly.dev`. Do not put
secrets in docs, compose, or examples. Local values belong in
`.env.local`.

Setup for a reviewer: [README.md](./README.md).
Agent rules: [AGENTS.md](./AGENTS.md).
