# Watchtower

Watchtower records what your coding agents tried, which of those
attempts failed, and the error that came back, so the next session
does not repeat the same approach.

It does not call a model. It does not care which model wrote the
turns. Claude, Grok, GPT, Gemini, a Cursor-hosted model, Kimi,
MiniMax, or a model you run on your own machine: if the tool writes
a session, Watchtower can store it.

This repository is the Apache-2.0 **capture client**. Version
**5.0.1**. It is source code you run on hardware you control.

## Contents

- [What this repository is](#what-this-repository-is)
- [What you get](#what-you-get)
- [Names](#names)
- [This is code. It is not our machines.](#this-is-code-it-is-not-our-machines)
- [The capture loop](#the-capture-loop)
- [Postgres](#postgres)
- [PostgREST](#postgrest)
- [The SUPABASE_ names](#the-supabase_-names)
- [Inngest](#inngest)
- [Docker Compose](#docker-compose)
- [Fly.io, Render, and a VM](#flyio-render-and-a-vm)
- [Models](#models)
- [If you want Braintied to stand one up](#if-you-want-braintied-to-stand-one-up)
- [What must already be installed](#what-must-already-be-installed)
- [Clone](#clone)
- [Env](#env)
- [Database and server](#database-and-server)
- [Claude Code hooks](#claude-code-hooks)
- [Other tools on disk](#other-tools-on-disk)
- [Prove a session landed](#prove-a-session-landed)
- [A public URL](#a-public-url)
- [What gets captured](#what-gets-captured)
- [Session keys](#session-keys)
- [Which project](#which-project)
- [Webhook](#webhook)
- [Environment](#environment)
- [Files](#files)

## What this repository is

A snapshot of how sessions leave a coding agent and land in a
database **you** run. Hooks fire when some tools stop. Disk adapters
read the session files other tools already write. A small server
accepts the POST. Postgres keeps the row.

Braintied built this for our own agents. The public tree is the
capture half. The rest of what we run (live session floor, operator
board, recall, journeys, error fingerprints, the hosted indexer) is
not here. You can build those on top of the rows this client writes,
or [ask us to](#if-you-want-braintied-to-stand-one-up).

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
so the agent is not blocked. Your transcript does not reach us.

`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` must be a database **you**
created, or the local compose stack. Those names are explained
[below](#the-supabase_-names). Do not paste a Braintied credential.
The compose JWT is a local stub.

```
your agent  -->  hook or disk adapter on your machine  -->  YOUR server :5003  -->  YOUR Postgres
```

Nothing in that line is Braintied infrastructure.

## The capture loop

A coding agent is a program that reads your repo, calls tools, and
writes code. Claude Code, Cursor, Codex, the Grok CLI, OpenCode,
Gemini CLI, and others all do that job. Watchtower does not run the
agent. It remembers what the agent already did.

Two ways a session gets in:

1. **A hook.** Some tools (Claude Code is the one this tree ships
   wired) can run a shell script when a session stops. That script
   is `hooks/session-ingest.sh`. It POSTs the transcript to your
   server.
2. **A disk adapter.** Other tools already write session files
   (`~/.codex/sessions`, `~/.grok/sessions`, `~/.cursor/projects`,
   `~/.local/share/opencode/opencode.db`). `src/session-adapters.ts`
   knows those layouts. You POST what `parse` returns.

A **webhook** is just an HTTP URL your server listens on. The hook
is a client. Your process on port 5003 is the server. The path is
`/webhooks/session`.

[Hono](https://hono.dev/) is the small Node HTTP framework that
leftover server uses (`src/index.ts`). You do not need to learn
Hono to run it.

## Postgres

[PostgreSQL](https://www.postgresql.org/) is the database. Rows live
in a schema named `watchtower`. The tables this snapshot creates
are in `migrations/001_init.sql`: `coding_sessions` and
`session_chunks`.

You talk to it with `psql` when you want to prove a row landed.
[Download](https://www.postgresql.org/download/) if you do not have
it. Compose already runs Postgres for you; `psql` is only the
client.

[pgvector](https://github.com/pgvector/pgvector) is a Postgres
extension that stores embedding vectors. The leftover analyzer uses
it if you turn embeddings on. Capture of the raw session does not
need it. Compose uses an image that already includes it.

## PostgREST

The leftover Node server does not open a raw SQL socket. It speaks
HTTP to [PostgREST](https://docs.postgrest.org/en/latest/), which
turns the `watchtower` tables into a REST API.

Compose publishes that API at `http://127.0.0.1:54321` on your
machine. Inside the compose network the same process is
`http://rest:3000`. Those two URLs are the same PostgREST. Use the
first from your laptop, the second from the `watchtower` container.

## The SUPABASE_ names

[Supabase](https://supabase.com/docs/guides/getting-started) is a
hosted product that bundles Postgres, PostgREST, and auth. The
leftover server uses the official `@supabase/supabase-js` client, so
the environment variables are named `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY`. Those names belong to the client library.
They are not a requirement to open a supabase.com account.

They can point at any of:

1. Local compose PostgREST (`http://127.0.0.1:54321` on the host,
   `http://rest:3000` in the container). No Supabase account.
2. A [Supabase project you created](https://supabase.com/docs/guides/getting-started).
3. Any PostgREST you run in front of your own Postgres 15.

`src/lib/db.ts` throws if either variable is missing or empty. The
value must be **yours**. A Braintied project URL is the wrong value.

The compose JWT in `docker-compose.yml` is a local stub for option
1. It is not a production key.

## Inngest

[Inngest](https://www.inngest.com/docs) is a background-job runner.
When a session POST lands, the leftover server can hand "analyze
this later" to Inngest so the webhook can return in milliseconds
instead of waiting on a model.

Compose starts a **local** Inngest on port 8288. You do not need an
Inngest cloud account to run on your laptop. Open
`http://127.0.0.1:8288` if you want to see queued jobs.

Capture still writes the `coding_sessions` row if you never open
that UI. Leave `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` empty and
the leftover analyzer has nothing to call. The row is still there.

The leftover server mounts Inngest at `/api/inngest`. That is how
the local Inngest process finds the functions. You do not configure
that by hand under compose.

## Docker Compose

[Docker](https://docs.docker.com/get-started/get-docker/) runs
small isolated machines (containers) on your laptop.
`docker-compose.yml` is the file that starts four of them with one
command: Postgres, PostgREST, local Inngest, and the Watchtower
server.

```bash
docker compose up --build
```

You do not have to use Docker. You can install Postgres yourself,
apply `migrations/001_init.sql`, point `SUPABASE_URL` at a
PostgREST in front of it, and run `npm start`. Compose is the path
that does not require you to wire those pieces by hand.

## Fly.io, Render, and a VM

Localhost is enough until a second machine needs to POST to you.
Then the webhook URL has to be reachable from that machine.

[Fly.io](https://fly.io/docs/launch/deploy/) and
[Render](https://render.com/docs/deploys) are companies that rent
you a small always-on computer with a public HTTPS URL. A VM you
already have (a Linux box, a home server) does the same job if you
put Node 20 and Postgres on it.

You create **your** app. You set
`WATCHTOWER_SESSION_WEBHOOK_URL` to **your** URL. You do not need
Fly to try Watchtower. You must not name a Fly app
`ora-watchtower` and you must not deploy against that name. That
app is ours. The hook refuses `ora-watchtower.fly.dev`.

## Models

Capture does not call a model and does not select one.

| Tool | How Watchtower sees it | Needs a model API key? |
|------|------------------------|------------------------|
| Claude Code | Stop / SessionStart hook | No |
| Cursor | `~/.cursor/projects/` | No |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | No |
| Grok CLI | `~/.grok/sessions/` | No |
| OpenCode | `~/.local/share/opencode/opencode.db` | No |
| Gemini CLI | `source=gemini` on the webhook | No |
| Anything that POSTs a `SessionPayload` | `src/types.ts` | No |

The leftover server ships an optional analyzer
(`src/inngest/session-analyzer.ts`) that, if you turn it on,
currently calls Anthropic and Voyage. That is a leftover from an
older self-host path, not a product requirement. Leave
`ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` empty. Capture still
works. Swap that leftover if you want a different provider.

Do not pin this snapshot to a model version. The agent that wrote
the turns is the agent's problem. Watchtower's job is the row.

## If you want Braintied to stand one up

We will stand up Watchtower for a company: your host, your
database, your agents. That is
[consulting](https://www.braintied.com/consulting) or an embed. You
still do not land on our Fly app or our database.

[hello@braintied.com](mailto:hello@braintied.com). Say you want
Watchtower hosted for your team.

## What must already be installed

| Tool | Why | Get it |
|------|-----|--------|
| Node 20+ | `npm start`, `npm install`, hook installer | [nodejs.org/en/download](https://nodejs.org/en/download) |
| npm | This snapshot is an npm repo | ships with Node |
| Git | clone | [git-scm.com/downloads](https://git-scm.com/downloads) |
| `jq` | Stop hook reads the tool's JSON. Without it the body is dropped | [jqlang.github.io/jq/download](https://jqlang.github.io/jq/download/) |
| `curl` | Stop hook POSTs the session | usually preinstalled |
| Docker (optional) | local Postgres + PostgREST + the server | [docs.docker.com/get-started/get-docker](https://docs.docker.com/get-started/get-docker/) |
| [Claude Code](https://code.claude.com/docs/en/overview) (optional) | easiest hook path | [code.claude.com](https://code.claude.com/docs/en/overview) |
| `psql` (optional) | prove a row landed | [postgresql.org/download](https://www.postgresql.org/download/) |

Disk adapters do not need Claude Code installed.

## Clone

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
```

Or the package (same capture code, no leftover server):

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
# Leftover server (src/lib/db.ts throws if these two are missing).
# Names come from @supabase/supabase-js. Values are YOUR PostgREST
# (compose) or a project you created. Not a Braintied URL.
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_KEY=replace-with-a-key-you-created

# Optional leftover analyzer only. Capture does not read these.
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

## Database and server

Local compose (your laptop, not our cloud):

```bash
docker compose up --build
```

| Port | What | Whose |
|------|------|--------|
| 54322 | Postgres 15 + pgvector | yours, volume `watchtower-db` |
| 54321 | PostgREST | yours |
| 8288 | local Inngest UI | yours |
| 5003 | Watchtower HTTP server | yours |

Migrations: `migrations/` is mounted into Postgres
`docker-entrypoint-initdb.d`. A first boot applies
`001_init.sql`. If the volume already exists empty of tables:

```bash
npx supabase db push --db-url "$WATCHTOWER_DATABASE_URL"
```

`WATCHTOWER_DATABASE_URL` is **your** URL. For compose, copy the
`postgres` service from `docker-compose.yml` (localhost port 54322).
The `supabase` CLI here is only a migration runner. It is not an
account.

Without Docker:

```bash
# provision your own Postgres 15 (pgvector optional)
# apply migrations/001_init.sql
# run PostgREST against that database
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
are the Stop and SessionStart triggers. This is the easiest prove
path because the tool fires the script for you. It is not the only
path, and it does not lock Watchtower to Anthropic's model.

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

Some other CLIs also read `~/.claude/settings.json`.
`hooks/grok/session-event.json` is a PostToolUse fragment for the
Grok CLI. The same refuse rule applies.

## Other tools on disk

The leftover webhook accepts every id in `CODING_SESSION_SOURCES`
(`claude_code`, `cursor`, `codex`, `gemini`, `opencode`, `grok`,
`kulti_meet`).

| Tool | On disk |
|------|---------|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Grok CLI | `~/.grok/sessions/` |

`src/session-adapters.ts` is `detect` / `discover` / `parse`.
`discover` is stat only. Codex `parse` streams: some rollouts are
multi-gigabyte and `readFileSync` will drop them.

To POST those files, call `POST /webhooks/session` with a
`SessionPayload` from `src/types.ts`, or walk the adapters yourself.

A new vendor is a new adapter plus a value on
`CODING_SESSION_SOURCES`. Open a pull request on this repository.

## Prove a session landed

1. `curl -sS http://localhost:5003/health` still returns ok.
2. Stop a real session in any captured tool. Claude Code Stop is
   the least wiring.
3. Query **your** Postgres:

```bash
psql -h localhost -p 54322 -U postgres -d postgres \
  -c "SELECT session_key, source, project_slug, message_count, created_at
      FROM watchtower.coding_sessions
      ORDER BY created_at DESC LIMIT 5;"
```

Compose credentials live in `docker-compose.yml`. Do not commit a
password into this tree.

A new row with your `session_key` means capture works. Zero rows is
a failed setup, not a quiet system. Check `jq` is installed, the
hook is registered or the adapter POST happened, and the webhook
URL is localhost (or your host), not ours.

## A public URL

When localhost is not enough, deploy **your** copy to
[Fly.io](https://fly.io/docs/launch/deploy/),
[Render](https://render.com/docs/deploys), or a VM that can run
Node 20 and reach your Postgres.

Set `WATCHTOWER_SESSION_WEBHOOK_URL` to that URL. Never to
`ora-watchtower.fly.dev`. Do not name your Fly app
`ora-watchtower`.

The leftover server needs `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` for a database you provision. `src/lib/db.ts`
throws if they are missing.

## What gets captured

Which tool ran the work must not decide whether the work is
remembered. Hooks cover the tools that fire them. Disk adapters
cover the rest.

Only `user` and `assistant` turns are forwarded
(`FORWARDED_ROLES`). Reasoning traces and tool output are dropped.
Tool names are kept. A message is capped at 20,000 characters
(`MAX_MESSAGE_CHARS` in `src/session-adapters.ts`). Codex rollouts
must be streamed.

## Session keys

`hooks/lib/session-key.sh` writes `source:<uuid>`:

```
claude:99918550-4efe-4c62-91aa-…
grok:01a0104f-e804-7a41-bbb7-a4c823c07d03
codex:0f3a…
```

Detection walks the parent process, every event, no whitelist.
Recognised: `claude`, `codex`, `cursor` / `cursor-agent`,
`opencode`, `grok`, `kimi`, `zai`, `minimax`. `GROK_AGENT` /
`GROK_HOME` short-circuit to `grok`. If nothing matches it writes
`claude`, because Claude Code is the host that loads
`~/.claude/settings.json` for other vendors too.

The `source` column is `claude_code` when the vendor is Claude
Code, and the vendor id otherwise.

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
| GET/POST/PUT | `/api/inngest` | leftover Inngest sync |

## Environment

| Variable | Default | Required |
|----------|---------|----------|
| `SUPABASE_URL` | none | yes, for `npm start`. Your PostgREST, not ours |
| `SUPABASE_SERVICE_KEY` | none | yes, for `npm start`. Yours |
| `WATCHTOWER_SESSION_WEBHOOK_URL` | `http://localhost:5003/webhooks/session` | no |
| `WATCHTOWER_SESSION_START_URL` | `http://localhost:5003/webhooks/session-start` | no |
| `WATCHTOWER_SOURCE_COLUMN` | from `session-key.sh` | no |
| `WATCHTOWER_SLUG_CACHE_DIR` | `~/.cache/watchtower/project-slug` | no |
| `WATCHTOWER_SLUG_TTL_MIN` | `1440` | no |
| `PORT` | `5003` | no |
| `ANTHROPIC_API_KEY` | none | leftover analyzer only |
| `VOYAGE_API_KEY` | none | leftover embeddings only |

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
| `hooks/grok/session-event.json` | Grok CLI PostToolUse fragment |
| `scripts/install-hooks.ts` | copies ingest + track, patches `settings.json` |
| `migrations/001_init.sql` | `coding_sessions` + `session_chunks` |
| `docker-compose.yml` | local Postgres / PostgREST / Inngest |

## License

Apache-2.0. Agents building this for a customer:
[AGENTS.md](./AGENTS.md). Humans sending a patch:
[CONTRIBUTING.md](./CONTRIBUTING.md).
