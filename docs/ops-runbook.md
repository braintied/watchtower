# Capture runbook

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 3
**Repo:** braintied/watchtower
**What this is:** Commands to stand up the public capture client

```bash
npm install
npm run install-hooks
WATCHTOWER_SESSION_WEBHOOK_URL=http://localhost:5003/webhooks/session
docker compose up --build
curl -sS http://localhost:5003/health
```

Compose starts **their** Postgres (54322), PostgREST (54321), local
Inngest (8288), and the HTTP server (5003). The `SUPABASE_` env
names are the leftover client's. They point at that PostgREST, not
at supabase.com, unless they choose a hosted project.

Leave `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` empty. Capture does
not call a model.

A hook or a disk adapter POSTs to
`http://localhost:5003/webhooks/session` unless
`WATCHTOWER_SESSION_WEBHOOK_URL` is set to **their** host.

Do not set it to `ora-watchtower.fly.dev`. Do not deploy an app
named `ora-watchtower`. The product is Watchtower. The public
package is `@braintied/watchtower-capture`.

Architecture: [architecture.md](./architecture.md).
Setup: [../README.md](../README.md).
