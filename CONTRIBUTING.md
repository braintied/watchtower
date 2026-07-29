# Contributing

## Where to send changes

| Change type | Where |
|-------------|--------|
| Session adapters (Codex, Grok, Cursor, …) | `braintied/stack` → `packages/watchtower` |
| Claude Code hooks (canonical) | `braintied/stack` → `packages/watchtower/hooks` |
| Runner brains / claude-providers bridge | `braintied/stack` → `packages/watchtower/scripts/brain.sh` |
| Project monitor pure logic | `braintied/stack` → `packages/watchtower/src/monitor` |
| Fly service, Inngest, webhooks | `braintied/ora-ai` → `apps/watchtower` |
| Public docs / OSS install story | this repo |

Do **not** add a parallel adapter or hook here that is not upstreamed to the stack package first. Drift is how we lost Codex sessions for months.

## Syncing the OSS snapshot

Hooks in this repo may lag the stack package. When releasing a public snapshot:

1. Copy open-safe hook scripts from `@braintied/watchtower` hooks (no fleet secrets).
2. Update the version note in README.
3. Do not vendor proprietary monitor or brain logic into this Apache tree.

## Local OSS development

```bash
npm install
npm test   # if present
```
