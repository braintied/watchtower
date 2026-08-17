# Watchtower

Capture coding sessions from Claude Code, Grok, Codex, Cursor, and OpenCode.
Hooks fire while you work. Adapters pick up the tools that have no hooks.
Everything posts to a webhook you run.

**5.0.1** · synced from [`@braintied/watchtower`](https://github.com/braintied/stack/tree/main/packages/watchtower) on every package publish.

## Install

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
npm run install-hooks
```

Claude Code Stop posts to `http://localhost:5003/webhooks/session` unless you set:

```bash
export WATCHTOWER_SESSION_WEBHOOK_URL=https://your-host/webhooks/session
```

Then `npm start` for the local server, or point the hook at your own.

Grok is tagged `grok:<id>`, Claude `claude:<id>`. That key lives in
`hooks/lib/session-key.sh`. Disk adapters for Grok, Codex, Cursor, and
OpenCode are in `src/session-adapters.ts`.

## This repo

The Apache capture client: hooks, adapters, session keys, and a small
self-host server. Floor, board, manage, and the hosted indexer stay in
the proprietary Braintied package.

## License

Apache-2.0
