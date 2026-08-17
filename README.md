# Watchtower

Watchtower is Braintied's session intelligence. It records what your
coding agents tried, which of those attempts failed, and the error that
came back, so the next session does not repeat the same approach.

This repository is the Apache capture client. It is version-locked to
[`@braintied/watchtower`](https://github.com/braintied/stack/tree/main/packages/watchtower)
**5.0.1**. `stack.mjs publish` runs
`packages/watchtower/scripts/sync-oss.mjs`, which overwrites the capture
files, this README, and [AGENTS.md](./AGENTS.md).

| Name | What it is |
|------|------------|
| Watchtower | What we built for ourselves, and the name of this code |
| `@braintied/watchtower-capture` | This repository, published on GitHub Packages. Apache. Your install. |
| `@braintied/watchtower` | Braintied's private fleet package (floor, board, manage, recall). Not this repo. Not published for you. |
| `github.com/braintied/watchtower` | The public tree. Releases live here. |
| `ora-watchtower.fly.dev` | Braintied's Fly indexer. Ours. The hook will refuse to POST here. |

## This is code. It is not our machines.

Cloning this repository does not give you Braintied's indexer, Fly
app, or database. You do not get a login. You do not share our
Supabase. Sessions you capture stay on a host you run, writing to
a database you provision.

[braintied.com/watchtower](https://www.braintied.com/watchtower) is
a public feed of *our* coding sessions. It is not an inbox. Pointing
`WATCHTOWER_SESSION_WEBHOOK_URL` at `ora-watchtower.fly.dev` (or at
any `ora-watchtower.internal` address) is refused by
`hooks/lib/refuse-hosted.sh`. The Stop hook still exits 0 so it
never blocks Claude Code. It just does not send us your transcript.

Default webhook is `http://localhost:5003/webhooks/session`. That is
a process on your laptop, started with `npm start` or
`docker compose up`.

| You run | We run (not included) |
|---------|------------------------|
| This capture client | `ora-watchtower` on Fly |
| Your webhook host | Cortex / our Supabase |
| Your Postgres (compose stub or your own) | `watchtower.*` on our project |
| Your Anthropic / Voyage keys, if you analyse | Our keys, our ledger |

The leftover 2026-03 server in `src/index.ts` talks to whatever
`SUPABASE_URL` you set. Leave it unset or point it at a project you
created. Do not paste a Braintied credential into it.

## If you want Braintied to build you one

We will stand up Watchtower for a company: your Fly (or equivalent),
your database, your session store, wired to your agents. That is
custom work, billed as [consulting](https://www.braintied.com/consulting)
or an embed. You still do not land on our machines.

Email [hello@braintied.com](mailto:hello@braintied.com). Say you want
Watchtower hosted for your team.

## What gets captured

Claude Code fires hooks from its own lifecycle. Everything else is a
disk adapter. The point of the registry is that which tool ran the work
must not decide whether the work is remembered.

Measured on the machine that built this, 2026-07-27: Claude Code was
already captured (~5 GB). Codex held 514 GB / 2,833 rollouts and none
of them were visible to Watchtower. Cursor had 1.2 GB. OpenCode's
schema was wired before it had a session, so the first real one lands
without a second wiring pass.

| Producer | How | On disk |
|----------|-----|---------|
| Claude Code | `hooks/session-ingest.sh` on Stop | `~/.claude/projects/<encoded-cwd>/<session-id>/` |
| Claude Code | `hooks/session-track.sh` on SessionStart | same |
| Grok | `src/session-adapters.ts` `grok` adapter, plus `hooks/grok/session-event.json` | `~/.grok/sessions/` |
| Codex | `codex` adapter | `~/.codex/sessions/**/rollout-*.jsonl` |
| Cursor | `cursor` adapter | `~/.cursor/projects/` |
| OpenCode | `opencode` adapter | `~/.local/share/opencode/opencode.db` |

Only `user` and `assistant` turns are forwarded (`FORWARDED_ROLES`).
Reasoning traces and tool output are dropped. Tool *names* are kept.
A single message is capped at 20,000 characters
(`MAX_MESSAGE_CHARS` in `src/session-adapters.ts`). Codex rollouts are
streamed line by line: `readFileSync` failed on 137 of 2,833 files
here, the largest 10 GB, and those were the sessions with the most
work in them.

## Session keys

Every hook sources `hooks/lib/session-key.sh`. New sessions write
`source:<uuid>`:

```
grok:01a0104f-e804-7a41-bbb7-a4c823c07d03
claude:99918550-4efe-4c62-91aa-…
codex:…
```

Detection walks the parent process, every event, no whitelist.
`GROK_AGENT` / `GROK_HOME` short-circuit to `grok`. The walk also
recognises `claude`, `codex`, `cursor` / `cursor-agent`, `opencode`,
`kimi`, `zai`, `minimax`. If nothing matches it writes `claude`,
because Claude Code is the host that loads `~/.claude/settings.json`
for other vendors too.

The `source` column written to the webhook is `claude_code` when the
vendor is Claude, and the vendor id otherwise
(`watchtower_source_column` in the same file).

`hooks/session-track.sh` in this tree still builds the 2026-03 key
`encoded-cwd/session-id`. The Stop hook uses `source:uuid`. Bind and
ingest used to disagree for exactly this reason (2026-08-13). Treat
`session-key.sh` as the contract. Do not copy the tracker.

## Which project

`hooks/lib/project-slug.sh` is the one writer. It prefers
`watchtower resolve-project` from the fleet CLI, then falls back to
the old shell ladder. The TypeScript source of the same ladder is
`src/project-slug.ts`.

1. `origin` remote basename, stable across worktrees, clones, and
   directory renames.
2. `--git-common-dir` parent, so a linked worktree resolves to the
   main checkout rather than to `sentigen-onboarding-demo`.
3. `basename(cwd)`, only when the directory is not a repo. Rejected
   when degenerate (`basename('/')` is empty).

Git environment variables that override `-C` (`GIT_DIR`,
`GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`, and the rest of the
list in `src/project-slug.ts`) are scrubbed first. A hook inherits
whatever the shell exported. Without the scrub, a session is
attributed to the hook's repository, or to nothing.

Slugs are cached under `~/.cache/watchtower/project-slug/` for
`WATCHTOWER_SLUG_TTL_MIN` minutes (default 1440).
`resolve_cwd_is_repo` is not cached: it is one `rev-parse`, and the
webhook needs it to tell `non_repo` (the cwd was `~`) from
`unresolved` (it was a repo and the slug still did not match).

Measured 2026-08-12, 24 hours: 174 of 276 sessions had no project.
74 were git worktrees whose basename is not a project. Another ~38
were real repos whose directory name is not their slug.

## Webhook

Default: `POST http://localhost:5003/webhooks/session`.

Override with `WATCHTOWER_SESSION_WEBHOOK_URL`. SessionStart uses
`WATCHTOWER_SESSION_START_URL`, default
`http://localhost:5003/webhooks/session-start`.

The OSS Stop hook (`hooks/session-ingest.sh`) POSTs:

```json
{
  "session_key": "claude:<uuid>",
  "source": "claude_code",
  "project_slug": "sentigen",
  "message_count": 12,
  "metadata": {
    "raw_content": "[user] …\n[assistant] …",
    "source_hook": "oss-session-ingest"
  }
}
```

`jq` is required to build the body. The Claude transcript is read
from `~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>/subagents/*.jsonl`,
capped at 50,000 characters. The curl is fire-and-forget
(`--connect-timeout 5 --max-time 30`, backgrounded). The hook always
prints `{"continue": true}` and exits 0. A missing `sessionId` is a
no-op, not a block.

The typed payload the fleet ingest path sends is `SessionPayload` in
`src/types.ts`: `session_key`, `source`, `project_slug`, `cwd`,
`cwd_is_repo`, `messages[]`, `tools_used`, `message_count`, start/end
timestamps, `metadata`. `cwd_is_repo` must not be defaulted to
`false` when omitted. An older CLI that leaves it off means unknown.

`CODING_SESSION_SOURCES` in that file is
`claude_code | cursor | codex | gemini | opencode | grok | kulti_meet`.
The leftover self-host server in `src/webhook/session.ts` still
validates only `claude_code | cursor | codex | gemini`. A Grok POST
to `npm start` on this tree will 400. Point the hook at the hosted
indexer, or widen that enum before you self-host Grok.

## Install

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
npm run install-hooks
```

`scripts/install-hooks.ts`:

1. Copies `hooks/session-ingest.sh` and `hooks/session-track.sh` to
   `~/.claude/hooks/` (mode 0755).
2. Registers them in `~/.claude/settings.json` as Stop and
   SessionStart command hooks.
3. Appends `WATCHTOWER_SESSION_WEBHOOK_URL` and
   `WATCHTOWER_SESSION_START_URL` to `~/.zshrc`, `~/.bashrc`, or
   `~/.profile` if those names are not already present.

```bash
npx tsx scripts/install-hooks.ts --dry-run
npx tsx scripts/install-hooks.ts --url https://your-host/webhooks/session
npm run uninstall-hooks
```

`--url` also derives the SessionStart URL by replacing a trailing
`/webhooks/session`. Open a new terminal, or `source` the profile,
after install.

Grok loads `~/.claude/settings.json` as well. The fragment at
`hooks/grok/session-event.json` is the PostToolUse /
PostToolUseFailure hook that calls `session-event.sh` (that script
is fleet-only; this snapshot ships the JSON so the wiring is
visible).

## Self-host

This is the path for anyone who is not Braintied. You bring the
compute and the database.

```bash
npm start          # src/index.ts, port 5003 (or $PORT)
npm run dev        # tsx watch
docker compose up  # Postgres 54322, PostgREST 54321, Inngest 8288, app 5003
```

Compose starts a *local* Postgres. It is not Braintied's Supabase.
After it is up:

```bash
npx supabase db push --db-url postgresql://postgres:postgres@localhost:54322/postgres
```

Schema is `migrations/001_init.sql` (`watchtower.coding_sessions`,
`watchtower.session_chunks`, pgvector). Set `SUPABASE_URL` and the
service key to *that* stack, or to a Supabase project you created.
The compose file's placeholder JWT is a local stub. Do not replace
it with a Braintied credential.

Routes on the leftover 2026-03 server:

| Method | Path | What |
|--------|------|------|
| GET | `/health` | `{ status: "ok", service: "watchtower" }` |
| POST | `/webhooks/session` | ingest |
| POST | `/webhooks/session-start` | start tracker |
| GET/POST/PUT | `/api/inngest` | Inngest sync |

This server is a 2026-03 Hono + Inngest snapshot. Floor, board,
manage, recall, journeys, and error fingerprints are not in it. To
get those running for your company, you either build on this
framework or hire us (above). You still do not share our Fly app.

## Install the capture package

Releases: [github.com/braintied/watchtower/releases](https://github.com/braintied/watchtower/releases).

```bash
# GitHub Packages (public capture client)
npm install @braintied/watchtower-capture --registry=https://npm.pkg.github.com

# or this tree
git clone https://github.com/braintied/watchtower.git
```

`@braintied/watchtower` (no `-capture`) is Braintied's private fleet
package. `pnpm add @braintied/watchtower` on a machine that is not
ours will not give you our indexer.

## Fleet CLI (Braintied machines)

On a Braintied Mac the CLI is `@braintied/watchtower` on PATH.

| Command | Job |
|---------|-----|
| `watchtower ingest run --since 2d` | POST disk sessions the hooks did not see |
| `watchtower resolve-project <dir>` | the slug ladder, exit 1 = no answer |
| `watchtower floor` | live sessions on this Mac |
| `watchtower board` | what needs a human |
| `watchtower recall "<q>"` | standing lessons |
| `watchtower doctor` | does capture actually work |
| `watchtower manage once` | dry-run ops plan |

Those commands are not in this repository. Adapters and hooks that
feed them are.

## Environment

| Variable | Default | Used by |
|----------|---------|---------|
| `WATCHTOWER_SESSION_WEBHOOK_URL` | `http://localhost:5003/webhooks/session` | Stop hook |
| `WATCHTOWER_SESSION_START_URL` | `http://localhost:5003/webhooks/session-start` | SessionStart hook |
| `WATCHTOWER_SOURCE_COLUMN` | from `session-key.sh` | Stop hook override |
| `WATCHTOWER_SLUG_CACHE_DIR` | `~/.cache/watchtower/project-slug` | `project-slug.sh` |
| `WATCHTOWER_SLUG_TTL_MIN` | `1440` | slug cache |
| `PORT` | `5003` | `npm start` |

## License

Apache-2.0. Agents: [AGENTS.md](./AGENTS.md). How to change capture:
[CONTRIBUTING.md](./CONTRIBUTING.md).
