# Watchtower

Apache-2.0 capture client. Humans: [README.md](./README.md).
Agents: [AGENTS.md](./AGENTS.md). Wiring:
[docs/architecture.md](./docs/architecture.md).

## Do not

- Do not point `WATCHTOWER_SESSION_WEBHOOK_URL` at
  `ora-watchtower.fly.dev`. That host is Braintied's. The hook
  refuses it.
- Do not treat `ora-watchtower` as the product name. The product
  is Watchtower. The public package is
  `@braintied/watchtower-capture`.
- Do not deploy using the Fly app name `ora-watchtower`.

## Verify

```bash
npm run typecheck
curl -sS http://localhost:5003/health
```
