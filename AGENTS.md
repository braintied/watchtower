# Watchtower — agent build rules

You are standing up Watchtower for a company that is not Braintied.
This file is the skill. Follow it in order. Do not improvise a
connection to our machines.

This tree is a generated Apache snapshot of the capture client in
`@braintied/watchtower 6.0.1`. Humans read [README.md](./README.md)
for the same setup, written for them.

## What you are building

A working capture loop:

```
their agent  -->  hook on their Mac  -->  THEIR server :5003  -->  THEIR Postgres
```

Done is not "the repo clones." Done is a row in **their**
`watchtower.coding_sessions` after they stop a Claude Code session.

## What you are not building

- Access to `ora-watchtower.fly.dev`
- Access to Braintied Cortex / Supabase
- Floor, board, manage, recall, journeys, error fingerprints
  (those live in the private fleet package and our indexer)
- A shared tenancy on our Fly app

`hooks/lib/refuse-hosted.sh` returns 0 for
`ora-watchtower.fly.dev` and `ora-watchtower.internal`. The OSS Stop
hook then skips curl and still exits 0. Do not add a bypass. Do not
set `WATCHTOWER_SESSION_WEBHOOK_URL` to our host "so the demo
works." Do not put our project URL in `.env.example` or compose.

If they want us to host it: [hello@braintied.com](mailto:hello@braintied.com),
their Fly, their database. Point them at
[consulting](https://www.braintied.com/consulting). Then stop.

## Execute this setup

Copy the commands. Check the verify after each step.

1. **Clone and install**

   ```bash
   git clone https://github.com/braintied/watchtower.git
   cd watchtower
   npm install
   ```

   Verify: `test -f hooks/session-ingest.sh && test -f src/index.ts`

2. **Write `.env.local` with their values**

   Required for the server: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
   `src/lib/db.ts` throws if either is missing. Use compose
   (`http://rest:3000` in the container, `http://127.0.0.1:54321` on
   the host) or a Supabase project **they** created.

   Webhook defaults are localhost. Leave them. Never our Fly host.

   Verify: `rg -n 'ora-watchtower|supabase.co' .env.local` prints
   nothing unless the supabase host is a project **they** created.

3. **Start their stack**

   ```bash
   docker compose up --build
   curl -sS http://localhost:5003/health
   ```

   Expect `{"status":"ok","service":"watchtower"}`. Connection
   refused: compose is not up. A body from a `*.fly.dev` host: you
   pointed at us. Stop and fix the URL.

4. **Install hooks on the machine that runs Claude Code**

   ```bash
   npx tsx scripts/install-hooks.ts --dry-run
   npx tsx scripts/install-hooks.ts --url http://localhost:5003/webhooks/session
   source ~/.zshrc
   ```

   Verify: `rg session-ingest ~/.claude/settings.json`
   and `test -x ~/.claude/hooks/session-ingest.sh`

5. **Grok / Codex / Cursor / OpenCode**

   `src/webhook/session.ts` `source` is `CODING_SESSION_SOURCES`.
   A Grok POST to `npm start` is valid. Adapters live in
   `src/session-adapters.ts`.

6. **Prove a row**

   Stop a real Claude Code session, then:

   ```bash
   psql postgresql://postgres@localhost:54322/postgres \
     -c "SELECT count(*) FROM watchtower.coding_sessions;"
   ```

   Count must be greater than zero. Zero is a failed setup, not a
   quiet system.

7. **Deploy only their host**

   If they need a public webhook, create **their** Fly/Render/VM.
   Set `WATCHTOWER_SESSION_WEBHOOK_URL` to that URL. Do not run
   `fly deploy` against `ora-watchtower`. Do not reuse our app name.

## Map

| Piece | Where | Writes code? |
|-------|--------|--------------|
| This snapshot | `github.com/braintied/watchtower` | No |
| Portable core | `braintied/stack` `packages/watchtower` · `@braintied/watchtower` | No |
| Hosted indexer | `ora-ai/platform/apps/watchtower` · Fly `ora-watchtower` | No |
| Runner pool | launchd `ai.ora.watchtower.runner-*` | **Yes** |
| Public package | `@braintied/watchtower-capture` | No |

Watchtower is the fleet (181 projects), not Sentigen. The product
is Watchtower. `ora-watchtower` is the Fly hostname.

Public package on this repo: `@braintied/watchtower-capture`.
`@braintied/watchtower` is the private fleet package on
`braintied/stack`. Do not publish the fleet tarball from here.

## What this tree actually contains

Synced (`ALLOWLIST` + generated hook + docs):

| Path | Contract |
|------|----------|
| `src/session-adapters.ts` | `detect` / `discover` / `parse` for codex, cursor, opencode, grok |
| `src/project-slug.ts` | three-rung resolver + GIT_* scrub |
| `src/types.ts` | `CODING_SESSION_SOURCES`, `SessionPayload`, localhost default URL |
| `hooks/lib/session-key.sh` | `source:<uuid>`, process walk, no event whitelist |
| `hooks/lib/session-key.test.sh` | must-fire / must-not-fire for the walker |
| `hooks/lib/project-slug.sh` | shell half of the resolver, cache, `cwd_is_repo` |
| `hooks/lib/refuse-hosted.sh` | refuse `ora-watchtower.fly.dev` / `.internal` |
| `hooks/grok/session-event.json` | Grok PostToolUse wiring |
| `hooks/session-ingest.sh` | OSS Stop hook, webhook only |

Leftover 2026-03 self-host server, **not** overwritten by sync:

| Path | Note |
|------|------|
| `src/index.ts` | Hono on `:5003` |
| `src/webhook/session.ts` | `source` is `CODING_SESSION_SOURCES` |
| `src/lib/db.ts` | throws without `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |
| `hooks/session-track.sh` | SessionStart. Still `encoded-cwd/session-id` |
| `scripts/install-hooks.ts` | copies ingest + track, patches settings.json |
| `migrations/001_init.sql` | `coding_sessions` + `session_chunks` only |
| `docker-compose.yml` | local Postgres / PostgREST / Inngest stub |

## Change path (Braintied maintainers)

1. Edit `braintied/stack` → `packages/watchtower`.
2. `pnpm run verify` in that package.
3. `node scripts/stack.mjs snapshot --only @braintied/watchtower`.
4. Do not add adapters, hooks, or session-key logic here first.

OSS Stop hook source is `packages/watchtower/oss/session-ingest.sh`.
The fleet `hooks/session-ingest.sh` is forbidden in this tree.

`sync-oss.mjs` refuses `FORBIDDEN` tokens (Cortex REST key name,
role name, proprietary license marker, grant-table name).

## Contracts

### session_key

`hooks/lib/session-key.sh` `watchtower_resolve_session_key`.
Requires `SESSION_ID`. Sets `SESSION_KEY`, `WATCHTOWER_SOURCE`,
`WATCHTOWER_SOURCE_COLUMN`. Shape `${WATCHTOWER_SOURCE}:${SESSION_ID}`.
Walk every event. Do not put the event name back on a whitelist.
Measured 2026-08-16: UserPromptSubmit missing, Grok wrote the human
prompt as `source=claude_code` on a `claude:<uuid>` twin.

### source

`CODING_SESSION_SOURCES` in `src/types.ts`. The leftover server enum
in `src/webhook/session.ts` is not that list until you make it so.

### project_slug

`src/project-slug.ts`. Shell half: `hooks/lib/project-slug.sh`.
CLI `watchtower resolve-project` when present. Exit 1 is "no
answer", not an empty slug. `cwd_is_repo` omitted means unknown.
Never coerce to `false`.

### OSS Stop payload

`session_key`, `source`, `project_slug`, `message_count`,
`metadata.raw_content`, `metadata.source_hook`. No `cwd`, no
`cwd_is_repo`, no `messages[]`. A server that requires `messages`
stores an empty transcript.

### Adapter

`detect` + `discover` + `parse`. `discover` is stat only. Codex
`parse` must stream. Add sources in `src/session-adapters.ts` **in
the stack package**, then sync.

## Traps

| Trap | Tell | Response |
|------|------|----------|
| Edit this repo first | PR against `braintied/watchtower` adding an adapter | Move to `stack/packages/watchtower`, sync |
| `ora-watchtower` as the product | docs or a new package named that | Product is Watchtower. That string is the Fly app |
| Sentigen as Watchtower | skip list scoped to one repo | 181 projects. Match `project_ids` |
| New `watchtower-core` | a second package | `@braintied/watchtower` already is the core |
| Put it in `~/Development/Braintied` | "Watchtower belongs in the company repo" | That tree is braintied.com |
| Inherit `GIT_DIR` | sessions attributed to the hook's repo | keep the scrub |
| Event whitelist on session-key | Grok user turns land on `claude:` | walk every event |
| Copy `session-track.sh` key rule | `encoded-cwd/id` vs `source:uuid` | `session-key.sh` is the writer |
| Self-host Grok against `npm start` | 400 on `source` | `z.enum(CODING_SESSION_SOURCES)` must stay |
| Default `cwd_is_repo` to false | attribution gap shrinks on paper | omit ≠ false |
| `readFileSync` a Codex rollout | silent drop of the largest sessions | stream |
| Deploy Fly from here | `fly deploy` in this checkout | their app, or stop |
| Point OSS hook at our Fly | sessions appear in Braintied Cortex | `refuse-hosted.sh` stays |
| Share our Supabase as a default | their data in our project | compose or a project they created |
| Empty `coding_sessions` called success | "setup done" with zero rows | prove a row |
| Secrets in this tree | compose, README, evidence | `.env.local` only |
| Next publish wipes a hand-edit | README/AGENTS revert | edit `packages/watchtower/oss/` |

## Verify

```bash
# Snapshot
npm run typecheck
curl -sS http://localhost:5003/health   # after compose

# Generator (Braintied)
cd <stack>/packages/watchtower
node scripts/sync-oss.test.mjs
```

`npm run typecheck` still covers the 2026-03 Hono/Inngest server.
That gate is pre-existing.

Drop `Braintied` from the human README and `sync-oss.test.mjs` must
go red. Empty the refuse denylist and `refuse-fly` must go red.

## Do not

- Do not add adapters, hooks, or session-key logic here first.
- Do not put floor, board, manage, journeys, or Cortex writers here.
- Do not treat `ora-watchtower` as the product name.
- Do not create `watchtower-core`.
- Do not put Watchtower inside `~/Development/Braintied`.
- Do not deploy the hosted indexer from this checkout.
- Do not treat Sentigen as Watchtower.
- Do not point `WATCHTOWER_SESSION_WEBHOOK_URL` at `ora-watchtower.fly.dev`.
- Do not force-push `main`.
- Do not delete the remote `watchtower` branch or close its PRs
  without G.

## Escalation

Stop and ask when the fix needs a Fly rename, a production deploy,
a new npm package name, or deleting a remote. Bring the file:line
and a recommendation, not a menu.

Humans: [README.md](./README.md).
