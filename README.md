# Watchtower

**Open-source AI coding session intelligence.**

Watchtower auto-captures your Claude Code sessions, AI-analyzes them (title, summary, category, key decisions), and makes them searchable with semantic vector search. Every session you run is automatically logged, indexed, and queryable.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![GitHub](https://img.shields.io/github/stars/braintied/watchtower)](https://github.com/braintied/watchtower)

## What It Does

```
You use Claude Code normally
  → Stop hook auto-fires when session ends
  → Extracts: messages, tool calls, file edits, bash commands, search queries
  → POSTs to Watchtower server
  → AI analyzes: generates title, summary, category, extracts key decisions
  → Embeds with Voyage AI for semantic search
  → Stored in PostgreSQL with pgvector

Later:
  "What did I work on yesterday?" → semantic search finds it
  "When did I fix the auth bug?" → instant answer with context
  "What decisions did I make about the database schema?" → extracted decisions
```

## Quick Start

### 1. Install hooks (30 seconds)

```bash
git clone https://github.com/braintied/watchtower.git
cd watchtower
npm install
npm run install-hooks
```

This installs two Claude Code hooks:
- **Stop hook** — captures session data when a session ends
- **Start hook** — tracks when sessions begin

### 2. Start the server

```bash
# With Docker (recommended)
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY and VOYAGE_API_KEY
docker compose up

# Or without Docker
npm run dev
```

### 3. Use Claude Code normally

Every session is now automatically captured and analyzed. That's it.

## What Gets Captured

| Data | Example |
|------|---------|
| **User messages** | Your prompts to Claude Code |
| **Assistant responses** | Claude's text responses |
| **Tool calls** | `Edit src/auth.ts: "old code" -> "new code"` |
| **Bash commands** | `npm run typecheck` → exit 0 |
| **Search queries** | `Grep "token.*expired" in src/` |
| **File operations** | Read, Write, Edit with file paths |
| **Agent delegations** | Sub-agent tasks and results |

All content passes through **secret redaction** before storage — API keys, tokens, and credentials are automatically stripped.

## AI Analysis

Every session gets:

| Analysis | Description |
|----------|-------------|
| **Title** | Concise 5-10 word title (e.g., "Fix auth middleware token expiry") |
| **Summary** | 2-3 sentence overview of what happened |
| **Category** | `feature`, `bugfix`, `refactor`, `debug`, `docs`, `config`, or `exploration` |
| **Decisions** | Key technical decisions with reasoning and context (max 5) |
| **Embeddings** | Voyage AI vector embeddings for semantic search |

## Architecture

```
Claude Code ──→ Stop hook ──→ POST /webhooks/session ──→ Hono server
                                                            │
                                                    Inngest event
                                                            │
                                                   Session Analyzer
                                                    ├── AI title/summary (Haiku)
                                                    ├── Category classification
                                                    ├── Decision extraction
                                                    ├── Chunking (2000 char, 10% overlap)
                                                    └── Voyage AI embeddings (1024 dims)
                                                            │
                                                    PostgreSQL + pgvector
                                                    ├── watchtower.coding_sessions
                                                    └── watchtower.session_chunks
```

**Stack**: Hono (HTTP) + Inngest (background jobs) + Supabase/PostgreSQL (storage) + pgvector (search) + Anthropic Haiku (analysis) + Voyage AI (embeddings + reranking)

## Built on AgentLog

Watchtower uses the [AgentLog](https://github.com/braintied/agentlog) open standard for session data interchange. Export any session as a portable AgentLog document:

```typescript
import { exportWatchtowerSession } from '@braintied/agentlog/convert/watchtower';
```

## Self-Hosting

### Requirements

- Node.js 22+
- PostgreSQL 15+ with pgvector extension
- Anthropic API key (for Haiku analysis)
- Voyage AI API key (for embeddings)

### With Docker Compose

```bash
cp .env.example .env
# Add your API keys to .env
docker compose up
```

### Without Docker

```bash
# 1. Set up PostgreSQL with pgvector
# 2. Run the migration
psql -f migrations/001_init.sql

# 3. Configure
cp .env.example .env
# Edit .env

# 4. Start
npm run dev
```

### Install Hooks

```bash
# Install Claude Code hooks
npm run install-hooks

# Or with a custom server URL
npm run install-hooks -- --url https://your-watchtower.example.com/webhooks/session

# Uninstall
npm run uninstall-hooks
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase/PostgREST URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `ANTHROPIC_API_KEY` | Yes | For Claude Haiku AI analysis |
| `VOYAGE_API_KEY` | Yes | For embeddings + reranking |
| `PORT` | No | Server port (default: 5003) |
| `GITHUB_TOKEN` | No | For commit analysis |

## Watchtower vs. Ora Cloud

Watchtower is the open-source core. [Ora Cloud](https://braintied.com) adds enterprise features:

| Feature | Watchtower OSS | Ora Cloud |
|---------|---------------|-----------|
| Session capture + analysis | Yes | Yes |
| Semantic search | Yes | Yes |
| Secret redaction | Yes | Yes |
| CLI | Yes | Yes |
| Single project | Yes | Yes |
| Multi-project fleet monitoring | — | Yes |
| Sentry/PostHog integration | — | Yes |
| AI cost tracking | — | Yes |
| Slack digests | — | Yes |
| Health scoring | — | Yes |
| Agent recall (AI agents search your sessions) | — | Yes |
| Team management | — | Yes |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We welcome:
- Bug fixes
- New tool converters (Cursor, Aider, Codex)
- Documentation improvements
- Feature suggestions

## License

Apache-2.0 — use it, modify it, ship it.

Built by [Braintied](https://braintied.com).
