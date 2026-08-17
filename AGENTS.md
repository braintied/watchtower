# Watchtower — agent skill

You are standing up Watchtower capture for a company that is not
Braintied. This file is the skill. Follow it in order. Do not
improvise a connection to Braintied machines.

This tree is a generated Apache-2.0 snapshot of the capture client
in `@braintied/watchtower-capture 5.0.1`. Humans read
[README.md](./README.md) for the same setup.

## What you are building

A working capture loop:

```
their agent  -->  hook on their Mac  -->  THEIR server :5003  -->  THEIR Postgres
```

Done is not "the repo clones." Done is a row in **their**
`watchtower.coding_sessions` after they stop a Claude Code session.

## What you are not connecting

- `ora-watchtower.fly.dev` or `ora-watchtower.internal`
- Any Braintied-hosted database
- Floor, board, manage, recall, journeys, error fingerprints
- A shared tenancy on our Fly app

`hooks/lib/refuse-hosted.sh` returns 0 for
`ora-watchtower.fly.dev` and `ora-watchtower.internal`. The OSS Stop
hook then skips curl and still exits 0. Do not add a bypass. Do not
set `WATCHTOWER_SESSION_WEBHOOK_URL` to our host "so the demo
works." Do not put our project URL in `.env.example` or compose.

If they want us to host it: [hello@braintied.com](mailto:hello@braintied.com),
**their** Fly, **their** database. Point them at
[consulting](https://www.braintied.com/consulting). Then stop.

## Execute this setup

Copy the commands. Check the verify after each step.

### 1. Clone and install

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
```

Need: [Node 20+](https://nodejs.org/en/download),
[Git](https://git-scm.com/downloads),
[jq](https://jqlang.github.io/jq/download/),
`curl`.

Verify: `test -f hooks/session-ingest.sh && test -f src/index.ts`

### 2. Write `.env.local` with their values

Required for the server: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
`src/lib/db.ts` throws if either is missing. Use compose
(`http://rest:3000` in the container, `http://127.0.0.1:54321` on
the host) or a [Supabase project they created](https://supabase.com/docs/guides/getting-started).

Webhook defaults are localhost. Leave them. Never our Fly host.

Verify: `rg -n 'ora-watchtower\.fly\.dev' .env.local` prints
nothing.

### 3. Start their stack

```bash
docker compose up --build
curl -sS http://localhost:5003/health
```

[Docker](https://docs.docker.com/get-started/get-docker/) if they
use compose. Expect `{"status":"ok","service":"watchtower"}`.
Connection refused: compose is not up. A body from a `*.fly.dev`
host: you pointed at us. Stop and fix the URL.

### 4. Install hooks on the machine that runs Claude Code

[Hook events](https://code.claude.com/docs/en/hooks).

```bash
npx tsx scripts/install-hooks.ts --dry-run
npx tsx scripts/install-hooks.ts --url http://localhost:5003/webhooks/session
source ~/.zshrc
```

Verify: `rg session-ingest ~/.claude/settings.json`
and `test -x ~/.claude/hooks/session-ingest.sh`

### 5. Grok / Codex / Cursor / OpenCode

`src/webhook/session.ts` `source` is `CODING_SESSION_SOURCES`.
A Grok POST to `npm start` is valid. Adapters live in
`src/session-adapters.ts`. Disk paths:

| Tool | Path |
|------|------|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Grok | `~/.grok/sessions/` |

### 6. Prove a row

Stop a real Claude Code session, then:

```bash
psql postgresql://postgres:postgres@localhost:54322/postgres \
  -c "SELECT count(*) FROM watchtower.coding_sessions;"
```

Count must be greater than zero. Zero is a failed setup, not a
quiet system.

### 7. Deploy only their host

If they need a public webhook, create **their**
[Fly](https://fly.io/docs/launch/deploy/) /
[Render](https://render.com/docs/deploys) / VM.
Set `WATCHTOWER_SESSION_WEBHOOK_URL` to that URL. Do not run
`fly deploy` against `ora-watchtower`. Do not reuse our app name.

## Files

| Path | Contract |
|------|----------|
| `src/session-adapters.ts` | `detect` / `discover` / `parse` for Codex, Cursor, OpenCode, Grok |
| `src/project-slug.ts` | three-rung resolver + `GIT_*` scrub |
| `src/types.ts` | `CODING_SESSION_SOURCES`, `SessionPayload`, localhost default URL |
| `src/index.ts` | leftover Hono server on `:5003` |
| `src/webhook/session.ts` | `source` is `CODING_SESSION_SOURCES` |
| `src/lib/db.ts` | throws without `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |
| `hooks/lib/session-key.sh` | `source:<uuid>`, process walk, no event whitelist |
| `hooks/lib/session-key.test.sh` | must-fire / must-not-fire for the walker |
| `hooks/lib/project-slug.sh` | shell half of the resolver, cache, `cwd_is_repo` |
| `hooks/lib/refuse-hosted.sh` | refuse `ora-watchtower.fly.dev` / `.internal` |
| `hooks/grok/session-event.json` | Grok PostToolUse wiring |
| `hooks/session-ingest.sh` | OSS Stop hook, webhook only |
| `hooks/session-track.sh` | SessionStart. Still `encoded-cwd/session-id` |
| `scripts/install-hooks.ts` | copies ingest + track, patches `settings.json` |
| `migrations/001_init.sql` | `coding_sessions` + `session_chunks` only |
| `docker-compose.yml` | local Postgres / PostgREST / Inngest stub |

## Contracts

### session_key

`hooks/lib/session-key.sh` `watchtower_resolve_session_key`.
Requires `SESSION_ID`. Sets `SESSION_KEY`, `WATCHTOWER_SOURCE`,
`WATCHTOWER_SOURCE_COLUMN`. Shape `${WATCHTOWER_SOURCE}:${SESSION_ID}`.
Walk every event. Do not put the event name back on a whitelist.

### source

`CODING_SESSION_SOURCES` in `src/types.ts`. Keep
`src/webhook/session.ts` on that same list. A Grok POST against a
narrower enum returns 400.

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
`parse` must stream. Add sources in `src/session-adapters.ts` and
open a pull request on this repository.

## Traps

| Trap | Tell | Response |
|------|------|----------|
| Point the hook at our Fly | `WATCHTOWER_SESSION_WEBHOOK_URL` contains `ora-watchtower` | `refuse-hosted.sh` stays; set localhost or their host |
| Share a Braintied database as a default | their data in our project | compose or a project they created |
| Empty `coding_sessions` called success | "setup done" with zero rows | prove a row |
| Inherit `GIT_DIR` | sessions attributed to the hook's repo | keep the scrub |
| Event whitelist on session-key | Grok user turns land on `claude:` | walk every event |
| Copy `session-track.sh` key rule | `encoded-cwd/id` vs `source:uuid` | `session-key.sh` is the writer |
| Self-host Grok against a narrow enum | 400 on `source` | `z.enum(CODING_SESSION_SOURCES)` must stay |
| Default `cwd_is_repo` to false | attribution gap shrinks on paper | omit ≠ false |
| `readFileSync` a Codex rollout | silent drop of the largest sessions | stream |
| Deploy Fly from here against our app | `fly deploy` / app name `ora-watchtower` | their app, or stop |
| Secrets in this tree | compose, README, evidence | `.env.local` only |
| Bypass `refuse-hosted.sh` so a demo works | sessions land on our indexer | do not |

## Pull requests

Outsiders open pull requests on
[braintied/watchtower](https://github.com/braintied/watchtower).
That is the door. Capture bugs, adapter fixes, hook fixes, and doc
fixes belong here.

This snapshot is generated from a private package. An accepted PR
is folded back and re-synced. Do not expect access to that package.
Do not add a second capture hook beside `hooks/session-ingest.sh`.
Do not add a connection to `ora-watchtower.fly.dev`.

## Verify

```bash
npm run typecheck
curl -sS http://localhost:5003/health   # after compose
```

`npm run typecheck` still covers the leftover Hono/Inngest server.

Empty the refuse denylist and a POST to `ora-watchtower.fly.dev`
must start succeeding: that is a failed change, not a cleanup.

## Do not

- Do not point `WATCHTOWER_SESSION_WEBHOOK_URL` at `ora-watchtower.fly.dev`.
- Do not treat `ora-watchtower` as the product name.
- Do not deploy using the app name `ora-watchtower`.
- Do not put Braintied credentials in `.env.example`, compose, or docs.
- Do not call an empty `coding_sessions` table a successful setup.
- Do not add a bypass to `hooks/lib/refuse-hosted.sh`.
- Do not force-push `main`.

## Escalation

Stop and ask the human when the fix needs a production deploy, a
new npm package name, or deleting a remote. Bring the file:line
and a recommendation, not a menu.

Humans: [README.md](./README.md).
