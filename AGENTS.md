# Watchtower — agents

This tree is a generated Apache snapshot of the capture client in
`@braintied/watchtower 5.0.1`.
`packages/watchtower/scripts/sync-oss.mjs` writes the allowlisted
capture files, `README.md`, and this file. Version numbers stay
locked to the stack package. `stack.mjs publish` runs the sync.

A competent agent with only this file and a terminal edits the
*right* tree. A careless one is stopped before it adds an adapter
here or deploys the Fly indexer from this checkout.

## Map

| Piece | Where | Writes code? |
|-------|--------|--------------|
| This snapshot | `github.com/braintied/watchtower` · `~/Development/watchtower` | No |
| Portable core | `braintied/stack` `packages/watchtower` · `@braintied/watchtower` | No |
| Hosted indexer | `ora-ai/platform/apps/watchtower` · Fly app `ora-watchtower` | No |
| Runner pool | launchd `ai.ora.watchtower.runner-*` | **Yes** |
| Company site | `~/Development/Braintied` (braintied.com) | No |

The product is Watchtower. `ora-watchtower` is the Fly hostname.
Watchtower is the fleet (181 projects, 12,926 sessions as of
2026-08-17), not Sentigen.

## What this tree actually contains

Synced on every publish (`ALLOWLIST` + generated hook + docs):

| Path | Contract |
|------|----------|
| `src/session-adapters.ts` | `detect` / `discover` / `parse` for codex, cursor, opencode, grok |
| `src/project-slug.ts` | three-rung resolver + GIT_* scrub |
| `src/types.ts` | `CODING_SESSION_SOURCES`, `SessionPayload`, localhost default URL |
| `hooks/lib/session-key.sh` | `source:<uuid>`, process walk, no event whitelist |
| `hooks/lib/session-key.test.sh` | must-fire / must-not-fire for the walker |
| `hooks/lib/project-slug.sh` | shell half of the resolver, cache, `cwd_is_repo` |
| `hooks/grok/session-event.json` | Grok PostToolUse wiring |
| `hooks/session-ingest.sh` | OSS Stop hook, webhook only |

Leftover 2026-03 self-host server, **not** overwritten by sync:

| Path | Note |
|------|------|
| `src/index.ts` | Hono on `:5003`, `/health`, `/webhooks/session`, `/webhooks/session-start`, `/api/inngest` |
| `src/webhook/session.ts` | Zod enum is `claude_code \| cursor \| codex \| gemini` only. Grok 400s |
| `hooks/session-track.sh` | SessionStart. Still builds `encoded-cwd/session-id`, not `source:uuid` |
| `scripts/install-hooks.ts` | copies ingest + track, patches `~/.claude/settings.json` |
| `migrations/001_init.sql` | `coding_sessions` + `session_chunks`, no journeys, no `error_signatures` |
| `docker-compose.yml` | local Postgres / PostgREST / Inngest stub |

`DEFAULT_WATCHTOWER_URL` is rewritten to `http://localhost:5003` on
sync. The fleet file still names `https://ora-watchtower.fly.dev`.

## Change path

1. Edit `braintied/stack` → `packages/watchtower`.
2. `pnpm run verify` in that package (typecheck + test + build).
3. `node packages/watchtower/scripts/sync-oss.mjs --apply`.
4. Do not add adapters, hooks, or session-key logic here first.

Webhook-only Stop hook source is
`packages/watchtower/oss/session-ingest.sh`, not the fleet
`hooks/session-ingest.sh`. The fleet hook talks to Cortex with a
privileged REST key and is forbidden in this tree.

`sync-oss.mjs` refuses to write if a synced file contains any token
in its `FORBIDDEN` list (the Cortex REST key name, the role name,
the proprietary license marker, and the grant-table name).

## Contracts

### session_key

`hooks/lib/session-key.sh` `watchtower_resolve_session_key`.
Requires `SESSION_ID`. Sets `SESSION_KEY`, `WATCHTOWER_SOURCE`,
`WATCHTOWER_SOURCE_COLUMN`. Shape is `${WATCHTOWER_SOURCE}:${SESSION_ID}`.
Walk every event. Do not put the event name back on a whitelist.
Measured 2026-08-16: UserPromptSubmit was missing, so Grok wrote the
human prompt as `source=claude_code` on a `claude:<uuid>` twin. Zero
grok `role=user` rows in 7 days against 421 grok sessions.

### source

`CODING_SESSION_SOURCES` in `src/types.ts` must stay in sync with
the Fly webhook enum in
`ora-ai/platform/apps/watchtower/src/webhook/session.ts`. Adding a
vendor is a major bump on the package (`kulti_meet` shipped as 5.0.0
for that reason). The leftover server enum in this repo is not that
enum.

### project_slug

`src/project-slug.ts` is the ladder. `hooks/lib/project-slug.sh`
delegates to `watchtower resolve-project` when the CLI is on PATH,
else the old `origin` / `basename` fallback. Exit 1 from the CLI
means "no answer", which is not an empty slug and must not be
cached. `cwd_is_repo` is a separate fact. `undefined` is unknown.
Never coerce it to `false`.

### OSS Stop payload

`hooks/session-ingest.sh` POSTs `session_key`, `source`,
`project_slug`, `message_count`, and
`metadata.raw_content` / `metadata.source_hook`. It does **not**
send `cwd`, `cwd_is_repo`, or `messages[]`. Fleet `watchtower ingest`
does. A server that requires `messages` will accept the hook and
store an empty transcript.

### Adapter

`detect` + `discover` + `parse`. `discover` is stat only.
`parse` returns `null` when there is nothing to forward.
Codex `parse` must stream. Adding a source is roughly thirty lines
in `src/session-adapters.ts` **in the stack package**.

## Traps

| Trap | Tell | Response |
|------|------|----------|
| Edit this repo first | PR against `braintied/watchtower` adding an adapter | Move the change to `stack/packages/watchtower`, sync |
| `ora-watchtower` as the product | docs, issues, or a new package named that | The product is Watchtower. That string is the Fly app |
| Sentigen as Watchtower | skip list / lessons scoped to one repo | 181 projects. Match `project_ids`, not only `last_project_id` |
| New `watchtower-core` | a second package next to this one | `@braintied/watchtower` already is the core |
| Put it in `~/Development/Braintied` | "Watchtower should live in the company repo" | That tree is braintied.com |
| Inherit `GIT_DIR` | sessions attributed to the hook's repo | `project-slug.sh` already scrubs. Keep it |
| Event whitelist on session-key | Grok user turns land on `claude:` | Walk every event |
| Copy `session-track.sh` key rule | `encoded-cwd/id` vs `source:uuid` | `session-key.sh` is the one writer |
| Self-host Grok against `npm start` | HTTP 400, Zod enum | Widen `src/webhook/session.ts` or POST to the hosted indexer |
| Default `cwd_is_repo` to false | attribution gap shrinks on paper | omit ≠ false |
| `readFileSync` a Codex rollout | silent drop of the largest sessions | stream |
| Deploy Fly from here | `fly deploy` in this checkout | Indexer lives in ora-ai. Needs G's deploy language |
| Secrets in this tree | compose file, README, evidence | `.env.local` only. Sync will refuse the known tokens |
| Next publish wipes a hand-edit | README/AGENTS/allowlist revert | Edit `packages/watchtower/oss/` or the allowlisted source |

## Verify

```bash
# This snapshot
npm run typecheck

# The package that generates it
cd <stack>/packages/watchtower
node scripts/sync-oss.test.mjs
pnpm run verify
```

`npm run typecheck` still covers the 2026-03 Hono/Inngest server.
That gate is pre-existing. A red typecheck on a README-only change
is not this snapshot's capture contract.

After you change `oss/README.md` or `oss/AGENTS.md`, run the test,
then `node scripts/sync-oss.mjs --apply` so `~/Development/watchtower`
matches. A check that cannot fail is not coverage: drop `Braintied`
from the human README and `sync-oss.test.mjs` must go red.

## Do not

- Do not add adapters, hooks, or session-key logic here first.
- Do not put floor, board, manage, journeys, or Cortex writers here.
- Do not treat `ora-watchtower` as the product name.
- Do not create `watchtower-core`.
- Do not put Watchtower inside `~/Development/Braintied`.
- Do not deploy the hosted indexer from this checkout.
- Do not treat Sentigen as Watchtower.
- Do not force-push `main`.
- Do not delete the remote `watchtower` branch or close its PRs
  without G.

## Escalation

Stop and ask when the fix needs a Fly rename, a production deploy,
a new npm package name, or deleting a remote. Bring the file:line
and a recommendation, not a menu.

Humans: [README.md](./README.md). Change path:
[CONTRIBUTING.md](./CONTRIBUTING.md). Fleet agent notes:
`stack/packages/watchtower/AGENTS.md`.
