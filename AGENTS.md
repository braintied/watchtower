# Watchtower — agents

This tree is a generated Apache snapshot of the capture client in
`@braintied/watchtower 5.0.1`.
`packages/watchtower/scripts/sync-oss.mjs` writes it. Version numbers
stay locked to the stack package.

## Do not

- Do not add adapters, hooks, or session-key logic here first. Change
  `braintied/stack` → `packages/watchtower`, then
  `node packages/watchtower/scripts/sync-oss.mjs --apply`.
- Do not put floor, board, manage, or Cortex writers in this repo.
- Do not treat `ora-watchtower` as the product. That string is the Fly
  app name. The product is Watchtower. The package is
  `@braintied/watchtower`.
- Do not create `watchtower-core` or put Watchtower inside
  `~/Development/Braintied` (that tree is braintied.com).
- Do not deploy the hosted indexer from this checkout.
- Do not treat Sentigen as Watchtower. Watchtower is the fleet.

## Work here only when

You are editing the public README, this file, the self-host server
(`src/index.ts` and the leftover 2026-03 Hono/Inngest tree), or docs
this snapshot owns.

## Verify

```bash
npm run typecheck
```

The public repo still typechecks that 2026-03 server. That gate is
pre-existing and unrelated to the capture snapshot.

## Map

| Piece | Where |
|-------|--------|
| This snapshot | `github.com/braintied/watchtower` |
| Portable core | `stack/packages/watchtower` · `@braintied/watchtower` |
| Hosted indexer | `ora-ai/platform/apps/watchtower` · Fly app `ora-watchtower` |
