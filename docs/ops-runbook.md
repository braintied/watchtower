# Watchtower capture client

**Created:** 2026-08-17 (PT)
**Updated:** 2026-08-17 (PT)
**Version:** 1

```bash
npm install
npm run install-hooks
WATCHTOWER_SESSION_WEBHOOK_URL=https://your-host/webhooks/session
npm start
```

Claude Code Stop posts to `http://localhost:5003/webhooks/session`
unless that env var is set.

The hosted indexer is a Fly app named `ora-watchtower`. Do not deploy
it from this checkout. The product is Watchtower. The fleet package is
`@braintied/watchtower`.

Architecture: [architecture.md](./architecture.md).
