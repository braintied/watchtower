# Watchtower

Apache capture client for Braintied Watchtower. Generated from
`@braintied/watchtower` by `packages/watchtower/scripts/sync-oss.mjs`.

Canon: [AGENTS.md](./AGENTS.md) · humans: [README.md](./README.md) ·
how it is wired: [docs/architecture.md](./docs/architecture.md).

## Do not

- Do not add adapters or hooks here first. Edit `braintied/stack`
  `packages/watchtower`, then run `sync-oss.mjs --apply`.
- Do not treat `ora-watchtower` as the product name. That is the Fly
  app. The product is Watchtower. The package is `@braintied/watchtower`.
- Do not deploy the hosted indexer from this checkout.

## Verify

```bash
npm run typecheck
```

The typecheck still covers the leftover 2026-03 Hono/Inngest server.
That gate is pre-existing.
