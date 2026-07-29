# Watchtower (open-source surface)

**Open-source AI coding session intelligence** — a public subset of Braintied Watchtower.

## Source of truth (fleet)

The full, maintained product lives in the Braintied stack monorepo:

| Package | What it owns |
|---------|----------------|
| **`@braintied/watchtower`** | Multi-agent session capture (Claude, Codex, Cursor, Grok, …), hooks, runner brains, project-monitoring pure logic |
| **ora-ai `apps/watchtower`** | Fly service (`ora-watchtower.fly.dev`) — webhooks, Inngest, Cortex |

```bash
# Fleet / internal
pnpm add @braintied/watchtower
watchtower ingest list
watchtower brains
```

This GitHub repo (`braintied/watchtower`) remains an **Apache-2.0 public surface** for the core idea (Claude Code hooks + session analysis). It is **not** a second implementation to keep in sync by hand.

- **New adapters, hooks, and brains** → contribute to `braintied/stack` → `packages/watchtower`
- **Service / deploy / steward** → `braintied/ora-ai`
- **This repo** → docs, public install story, and a simplified OSS snapshot

## What this repo still does

```
You use Claude Code normally
  → Stop hook captures the session
  → AI analyzes title, summary, category, decisions
  → Semantic search over past work
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how the OSS tree relates to the stack package.

## Quick start (OSS subset)

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
npm run install-hooks
```

For multi-agent ingest (Codex, Grok, …), multi-brain runners (z.ai / Kimi / MiniMax), and the live Fly indexer, use **`@braintied/watchtower`** and the Ora Watchtower service — not this simplified tree.

## License

Apache-2.0 (this public surface). The fleet package `@braintied/watchtower` is proprietary Braintied software.
