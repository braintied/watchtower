# Contributing

This repo is a **generated snapshot** of the open capture client in
`@braintied/watchtower`. Do not add adapters or hooks here first.

| Change | Where |
|--------|--------|
| Adapters, session-key, project-slug, types | `braintied/stack` → `packages/watchtower` |
| Webhook-only Stop hook | `packages/watchtower/oss/session-ingest.sh` |
| Fly service / Cortex writers / floor / board / manage | `braintied/stack` or `braintied/ora-ai` — not here |

After the package lands:

```bash
node packages/watchtower/scripts/sync-oss.mjs --apply --push
```

`stack.mjs publish` runs that automatically when `@braintied/watchtower`
publishes. Version numbers stay locked.
