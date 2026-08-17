# Watchtower

Watchtower is Braintied's session intelligence. It remembers what your
coding agents already tried, so the next session does not retry the
same failure.

This repository is the Apache capture client. Hooks fire while you work
in Claude Code. Adapters pick up Grok, Codex, Cursor, and OpenCode.
Everything posts to a webhook you run.

**5.0.1** · synced from [`@braintied/watchtower`](https://github.com/braintied/stack/tree/main/packages/watchtower) on every package publish.

The product is **Braintied Watchtower**. The installable fleet package is
[`@braintied/watchtower`](https://github.com/orgs/braintied/packages/npm/package/watchtower)
on GitHub Packages. `ora-watchtower` is only the Fly hostname of the
hosted indexer, leftover from when the service lived in the Ora
platform. It is not the product name.

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

## What this tree ships

- `hooks/` — Claude Code Stop and the Grok session-event hook
- `src/session-adapters.ts` — disk parsers for Grok, Codex, Cursor, OpenCode
- `hooks/lib/session-key.sh` — stable `grok:<id>` / `claude:<id>` keys
- a small self-host server you can point the webhook at

Floor, board, manage, recall, and the hosted indexer stay in the
Braintied package. Do not look for them here.

Agents: read [AGENTS.md](./AGENTS.md).

## License

Apache-2.0
