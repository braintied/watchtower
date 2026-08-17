# Watchtower

Watchtower records what your coding agents tried, which of those
attempts failed, and the error that came back, so the next session
does not repeat the same approach.

This repository is the Apache-2.0 **capture client**. Version
**5.0.1**. It is source code you run on hardware you control.

## What this repository is

A snapshot of how sessions leave Claude Code, Grok, Codex, Cursor,
and OpenCode and land in a database. Braintied built it for our own
agents. The public tree is the capture half: hooks, disk adapters,
session keys, and a small server.

The rest of what we run (live session floor, operator board, recall,
journeys, error fingerprints, the hosted indexer) is not in this
repository. You can build those on top of the rows this client
writes, or [ask us to](#if-you-want-braintied-to-stand-one-up).

## What you get

| You get | You do not get |
|---------|----------------|
| This code, Apache-2.0 | A login, an API key, or a seat on Braintied machines |
| Hooks that fire when [Claude Code](https://code.claude.com/docs/en/hooks) stops | Braintied's Fly app (`ora-watchtower.fly.dev`) |
| Adapters that read Grok, Codex, Cursor, and OpenCode off disk | Braintied's hosted Postgres |
| A local server on port 5003 | Floor, board, manage, recall, journeys |
| `migrations/001_init.sql` for **your** Postgres | Our keys, our cost ledger, our session store |
| Releases and `@braintied/watchtower-capture` | `@braintied/watchtower` (private fleet package) |

[braintied.com/watchtower](https://www.braintied.com/watchtower) is a
public feed of **our** sessions. It is not an inbox for yours.

## Names

| Name | What it is |
|------|------------|
| Watchtower | The product, and this code |
| [braintied/watchtower](https://github.com/braintied/watchtower) | This public repository |
| `@braintied/watchtower-capture` | This repo on [GitHub Packages](https://github.com/orgs/braintied/packages/npm/package/watchtower-capture) |
| `@braintied/watchtower` | Braintied's private fleet package. Installing it does not give you our indexer |
| `ora-watchtower.fly.dev` | Our hosted indexer. The hook [refuses it](#this-is-code-it-is-not-our-machines) |
| [Releases](https://github.com/braintied/watchtower/releases) | Tagged snapshots of this tree |

## This is code. It is not our machines.

Default webhook is `http://localhost:5003/webhooks/session`. That is
a process on the machine that ran `npm start` or `docker compose up`.

If `WATCHTOWER_SESSION_WEBHOOK_URL` is set to
`ora-watchtower.fly.dev` or `ora-watchtower.internal`,
`hooks/lib/refuse-hosted.sh` skips the POST. The hook still exits 0
so Claude Code is not blocked. Your transcript does not reach us.

`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` must be a project **you**
created, or the local compose stack. Do not paste a Braintied
credential. The compose JWT is a local stub.

```
your agent  -->  hook on your Mac  -->  YOUR server :5003  -->  YOUR Postgres
```

Nothing in that line is Braintied infrastructure.

## If you want Braintied to stand one up

We will stand up Watchtower for a company: your host, your database,
your agents. That is [consulting](https://www.braintied.com/consulting)
or an embed. You still do not land on our Fly app or our database.

[hello@braintied.com](mailto:hello@braintied.com). Say you want
Watchtower hosted for your team.

## What must already be installed

| Tool | Why | Get it |
|------|-----|--------|
| Node 20+ | `npm start`, `npm install`, hook installer | [nodejs.org/en/download](https://nodejs.org/en/download) |
| npm | This snapshot is an npm repo | ships with Node |
| Git | clone | [git-scm.com/downloads](https://git-scm.com/downloads) |
| `jq` | Stop hook reads Claude Code JSON. Without it the body is dropped | [jqlang.github.io/jq/download](https://jqlang.github.io/jq/download/) |
| `curl` | Stop hook POSTs the session | usually preinstalled |
| Docker (optional) | local Postgres + PostgREST + the server | [docs.docker.com/get-started/get-docker](https://docs.docker.com/get-started/get-docker/) |
| [Claude Code](https://code.claude.com/docs/en/overview) (optional) | Stop / SessionStart hooks | [code.claude.com](https://code.claude.com/docs/en/overview) |
| `psql` (optional) | prove a row landed | [postgresql.org/download](https://www.postgresql.org/download/) |

Grok, Codex, Cursor, and OpenCode work through disk adapters. They
do not need Claude Code installed.

## Clone

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
```

Or the package (same code, no leftover server):

```bash
npm install @braintied/watchtower-capture --registry=https://npm.pkg.github.com
```

GitHub Packages needs a token that can `read:packages`.
[Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

`@braintied/watchtower` (no `-capture`) is Braintied's private fleet
package. Installing it does not give you our indexer.

## Env

There is no `.env` in the repo. Copy this to `.env.local` and fill
**your** values. Empty Braintied URLs stay empty.

```bash
# Server (src/lib/db.ts throws if these two are missing)
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_KEY=replace-with-a-key-you-created

# Optional: only if you want the leftover analyzer to call models
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=

# Hooks. Localhost is the default. Do not set ora-watchtower.fly.dev.
WATCHTOWER_SESSION_WEBHOOK_URL=http://localhost:5003/webhooks/session
WATCHTOWER_SESSION_START_URL=http://localhost:5003/webhooks/session-start

PORT=5003
```

For compose, `SUPABASE_URL=http://rest:3000` inside the app
container (see `docker-compose.yml`). On the host, PostgREST is
`http://127.0.0.1:54321`.

A new hosted database: [Supabase getting started](https://supabase.com/docs/guides/getting-started)
or any Postgres 15 with [pgvector](https://github.com/pgvector/pgvector)
and [PostgREST](https://docs.postgrest.org/en/latest/).

## Database and server

Local compose (your laptop, not our cloud):

```bash
docker compose up --build
```

| Port | What | Whose |
|------|------|--------|
| 54322 | Postgres 15 + pgvector | yours, volume `watchtower-db` |
| 54321 | PostgREST | yours |
| 8288 | Inngest dev | yours |
| 5003 | Watchtower Hono server | yours |

Migrations: `migrations/` is mounted into Postgres
`docker-entrypoint-initdb.d`. A first boot applies
`001_init.sql`. If the volume already exists empty of tables:

```bash
npx supabase db push --db-url postgresql://postgres:postgres@localhost:54322/postgres
```

Without Docker:

```bash
# provision your own Postgres with pgvector
# apply migrations/001_init.sql
# export SUPABASE_URL and SUPABASE_SERVICE_KEY
npm start
```

Verify the process you started, not ours:

```bash
curl -sS http://localhost:5003/health
# expect: {"status":"ok","service":"watchtower"}
```

A connection refused means `npm start` / compose is not running.
A response from `ora-watchtower.fly.dev` means you pointed at us.
Stop. Set the env back to localhost or to a host you control.

## Claude Code hooks

[Claude Code hook events](https://code.claude.com/docs/en/hooks)
are the Stop and SessionStart triggers.

```bash
npm run install-hooks
# or: npx tsx scripts/install-hooks.ts --dry-run
# or: npx tsx scripts/install-hooks.ts --url http://localhost:5003/webhooks/session
```

That script:

1. Copies `hooks/session-ingest.sh` and `hooks/session-track.sh` to
   `~/.claude/hooks/` (mode 0755).
2. Registers Stop and SessionStart in `~/.claude/settings.json`.
3. Appends the two `WATCHTOWER_*` URLs to `~/.zshrc`, `~/.bashrc`,
   or `~/.profile` if those names are not already set.

Then:

```bash
source ~/.zshrc    # or ~/.bashrc
npm run uninstall-hooks   # to reverse
```

`--url` must be **your** webhook. If you pass
`https://ora-watchtower.fly.dev/webhooks/session`, the hook will
load, then refuse every POST.

Grok also reads `~/.claude/settings.json`.
`hooks/grok/session-event.json` is the PostToolUse fragment.

## Prove a session landed in your database

1. `curl -sS http://localhost:5003/health` still returns ok.
2. Open Claude Code in any repo, send one message, stop the session.
3. Query **your** Postgres:

```bash
psql postgresql://postgres:postgres@localhost:54322/postgres \
  -c "SELECT session_key, source, project_slug, message_count, created_at
      FROM watchtower.coding_sessions
      ORDER BY created_at DESC LIMIT 5;"
```

A new row with `source_hook` / your `session_key` means capture
works. Zero rows is a failed setup, not a quiet system. Check `jq`
is installed, the hook is in `~/.claude/settings.json`, and the
webhook URL is localhost (or your host), not ours.

## Grok, Codex, Cursor, OpenCode

The self-host webhook accepts every id in `CODING_SESSION_SOURCES`
(`claude_code`, `cursor`, `codex`, `gemini`, `opencode`, `grok`,
`kulti_meet`).

Disk paths the adapters already know:

| Tool | On disk |
|------|---------|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Grok | `~/.grok/sessions/` |

`src/session-adapters.ts` is `detect` / `discover` / `parse`.
`discover` is stat only. Codex `parse` streams: some rollouts are
multi-gigabyte and `readFileSync` will drop them.

To POST those files, call `POST /webhooks/session` with a
`SessionPayload` from `src/types.ts`, or walk the adapters yourself.

## Put the server on a host you control

When localhost is not enough, deploy **your** copy:

- [Fly.io](https://fly.io/docs/launch/deploy/)
- [Render](https://render.com/docs/deploys)
- any VM that can run Node 20 and reach your Postgres

Set `WATCHTOWER_SESSION_WEBHOOK_URL` to that URL. Never to
`ora-watchtower.fly.dev`. Do not name your Fly app `ora-watchtower`.

The server needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` for a
database you provision. `src/lib/db.ts` throws if they are missing.

## What gets captured

Claude Code fires hooks from its own lifecycle. Everything else is a
disk adapter. Which tool ran the work must not decide whether the
work is remembered.

Only `user` and `assistant` turns are forwarded
(`FORWARDED_ROLES`). Reasoning traces and tool output are dropped.
Tool names are kept. A message is capped at 20,000 characters
(`MAX_MESSAGE_CHARS` in `src/session-adapters.ts`). Codex rollouts
must be streamed.

## Session keys

`hooks/lib/session-key.sh` writes `source:<uuid>`:

```
grok:01a0104f-e804-7a41-bbb7-a4c823c07d03
claude:99918550-4efe-4c62-91aa-…
```

Detection walks the parent process, every event, no whitelist.
`GROK_AGENT` / `GROK_HOME` short-circuit to `grok`. Also recognised:
`claude`, `codex`, `cursor` / `cursor-agent`, `opencode`, `kimi`,
`zai`, `minimax`. If nothing matches it writes `claude`, because
Claude Code is the host that loads `~/.claude/settings.json` for
other vendors too.

The `source` column is `claude_code` when the vendor is Claude, and
the vendor id otherwise.

`hooks/session-track.sh` still builds an older key
`encoded-cwd/session-id`. The Stop hook uses `source:uuid`. Treat
`session-key.sh` as the contract. Do not copy the tracker.

## Which project

`hooks/lib/project-slug.sh` is the one writer. It prefers a
`watchtower resolve-project` CLI when that binary is on PATH, then
the shell ladder. TypeScript source: `src/project-slug.ts`.

1. `origin` remote basename.
2. `--git-common-dir` parent, so a linked worktree resolves to the
   main checkout rather than to a worktree folder name.
3. `basename(cwd)`, only when the directory is not a repo.

`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`, and the rest
of the list in `src/project-slug.ts` are scrubbed first. Slugs
cache under `~/.cache/watchtower/project-slug/` for
`WATCHTOWER_SLUG_TTL_MIN` minutes (default 1440).
`resolve_cwd_is_repo` is not cached.

`cwd_is_repo` omitted means unknown. Never default it to `false`.

## Webhook

The OSS Stop hook POSTs:

```json
{
  "session_key": "claude:<uuid>",
  "source": "claude_code",
  "project_slug": "your-repo",
  "message_count": 12,
  "metadata": {
    "raw_content": "[user] …\n[assistant] …",
    "source_hook": "oss-session-ingest"
  }
}
```

`jq` is required. Transcript comes from
`~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>/subagents/*.jsonl`,
capped at 50,000 characters. Curl is fire-and-forget
(`--connect-timeout 5 --max-time 30`). The hook always prints
`{"continue": true}` and exits 0.

The typed payload (`SessionPayload` in `src/types.ts`) also has
`cwd`, `cwd_is_repo`, `messages[]`, `tools_used`, timestamps.

Server routes (`src/index.ts`):

| Method | Path | What |
|--------|------|------|
| GET | `/health` | `{ status: "ok", service: "watchtower" }` |
| POST | `/webhooks/session` | ingest |
| POST | `/webhooks/session-start` | start tracker |
| GET/POST/PUT | `/api/inngest` | Inngest sync |

## Environment

| Variable | Default | Required |
|----------|---------|----------|
| `SUPABASE_URL` | none | yes, for `npm start` |
| `SUPABASE_SERVICE_KEY` | none | yes, for `npm start` |
| `WATCHTOWER_SESSION_WEBHOOK_URL` | `http://localhost:5003/webhooks/session` | no |
| `WATCHTOWER_SESSION_START_URL` | `http://localhost:5003/webhooks/session-start` | no |
| `WATCHTOWER_SOURCE_COLUMN` | from `session-key.sh` | no |
| `WATCHTOWER_SLUG_CACHE_DIR` | `~/.cache/watchtower/project-slug` | no |
| `WATCHTOWER_SLUG_TTL_MIN` | `1440` | no |
| `PORT` | `5003` | no |
| `ANTHROPIC_API_KEY` | none | only if you use the leftover analyzer |
| `VOYAGE_API_KEY` | none | only if you embed |

## Files

| Path | What it is |
|------|------------|
| `src/session-adapters.ts` | `detect` / `discover` / `parse` for Codex, Cursor, OpenCode, Grok |
| `src/project-slug.ts` | three-rung resolver + `GIT_*` scrub |
| `src/types.ts` | `CODING_SESSION_SOURCES`, `SessionPayload`, localhost default URL |
| `src/index.ts` | leftover Hono server on `:5003` |
| `src/webhook/session.ts` | ingest; `source` is `CODING_SESSION_SOURCES` |
| `src/lib/db.ts` | throws without `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |
| `hooks/session-ingest.sh` | Stop hook, webhook only |
| `hooks/session-track.sh` | SessionStart. Still `encoded-cwd/session-id` |
| `hooks/lib/session-key.sh` | `source:<uuid>`, process walk, no event whitelist |
| `hooks/lib/project-slug.sh` | shell half of the resolver |
| `hooks/lib/refuse-hosted.sh` | refuse `ora-watchtower.fly.dev` / `.internal` |
| `hooks/grok/session-event.json` | Grok PostToolUse wiring |
| `scripts/install-hooks.ts` | copies ingest + track, patches `settings.json` |
| `migrations/001_init.sql` | `coding_sessions` + `session_chunks` |
| `docker-compose.yml` | local Postgres / PostgREST / Inngest stub |

## License

Apache-2.0. Agents building this for a customer:
[AGENTS.md](./AGENTS.md). Humans sending a patch:
[CONTRIBUTING.md](./CONTRIBUTING.md).
