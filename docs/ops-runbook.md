# Capture runbook

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 2
**Repo:** braintied/watchtower
**What this is:** Commands to stand up the public capture client

```bash
npm install
npm run install-hooks
WATCHTOWER_SESSION_WEBHOOK_URL=http://localhost:5003/webhooks/session
docker compose up --build
curl -sS http://localhost:5003/health
```

Claude Code Stop posts to `http://localhost:5003/webhooks/session`
unless that env var is set to **your** host.

Do not set it to `ora-watchtower.fly.dev`. Do not deploy an app
named `ora-watchtower`. The product is Watchtower. The public
package is `@braintied/watchtower-capture`.

Architecture: [architecture.md](./architecture.md).
Setup: [../README.md](../README.md).
