/**
 * Session-capture adapters — one per agent/IDE.
 *
 * Owned by @braintied/watchtower (stack). Platform/ora-ai re-exports or depends on this package.
 *
 * WHY AN ADAPTER REGISTRY AND NOT A SCRIPT PER TOOL
 * -------------------------------------------------
 * Watchtower's original capture was Claude Code only, because its hooks fire
 * from Claude Code's own lifecycle. Everything else was invisible. That cost a
 * real architectural finding on 2026-07-21: a Codex audit concluded Ora needs
 * "one traceable work-graph identity" across its loop layers, Watchtower indexed
 * 299 sessions that day and none of them contained it, and a second audit
 * re-derived the same conclusion six days later because the first was written
 * somewhere nothing could read.
 *
 * The lesson is not "add Codex". It is that which tool ran the work should not
 * determine whether the work is remembered. So sources are data, not code
 * branches: an adapter declares where its transcripts live and how to read one,
 * and the runner does discovery, POSTing, idempotency, and reporting.
 *
 * Adding a source is `detect` + `discover` + `parse`, roughly thirty lines.
 *
 * MEASURED LANDSCAPE, 2026-07-27 (this machine)
 *   claude-code   ~5.0G   captured already, by hooks — deliberately not duplicated here
 *   codex          514G   2,833 rollouts   <- the whole corpus was invisible
 *   cursor         1.2G   2 transcripts
 *   opencode       132M   SQLite, 0 sessions (installed, unused)
 *   antigravity    161M   7 protobuf conversations
 *   gemini-cli       —    config and credentials only, no transcripts exist
 *
 * An adapter for an empty source is not wasted: opencode's schema is correct
 * today, so the first real session is captured without anyone noticing it needs
 * wiring. That is the difference between a registry and a to-do list.
 */

import { createReadStream, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import type { CapturedMessage, SessionPayload } from './types.js';

export type { CapturedMessage, SessionPayload };

/** A discovered, not-yet-parsed session. Shape is adapter-private beyond mtimeMs. */
export interface DiscoveredSession {
  mtimeMs: number;
  [key: string]: unknown;
}

export interface SessionAdapter {
  /** Stable id, used by --only and in logs. */
  readonly id: string;
  /** Value written to coding_sessions.source; must be accepted by the webhook enum. */
  readonly source: string;
  /**
   * May this adapter's payload go to `POST /webhooks/session`? Default true.
   *
   * False for a BACKFILL adapter — one writing turns onto session rows some
   * other producer already owns. The webhook is not a passive recorder: on
   * `origin/main` it reassigns `turn_index` itself as a per-role ordinal over
   * the messages it kept (ignoring the ones the payload supplies), upserts with
   * `metadata = EXCLUDED.metadata`, and sets `coding_sessions.message_count =
   * EXCLUDED.message_count` outright.
   *
   * For the Claude adapters all three are destructive. The reassigned ordinals
   * collide with the hook-owned assistant numbering this package went to
   * trouble to reproduce; the metadata overwrite strips `human_authored` and
   * `redacted` off every row it touches; and a `claude-history` payload
   * carrying 22 typed prompts would overwrite the real `message_count` of a
   * 400-message session — the number `session-analysis-trigger` gates on.
   *
   * So they persist and do not post. The session rows already exist: the hooks
   * create them at SessionStart, which is the whole reason these adapters key
   * on `claude:<uuid>`.
   */
  readonly postsSession?: boolean;
  /** Is this tool present on this machine at all? */
  detect(): boolean;
  /** Sessions touched since `sinceMs`. Cheap: stat only, no parsing. */
  discover(sinceMs: number): DiscoveredSession[];
  /** Full parse. Returns null when a session has no forwardable content. */
  parse(file: DiscoveredSession): Promise<SessionPayload | null>;
}

// Only durable conversational content is forwarded. Reasoning traces and tool
// OUTPUT are excluded — they are the bulk of the bytes and are not what anyone
// searches for later. Tool NAMES are kept, as a facet.
export const FORWARDED_ROLES = new Set<string>(['user', 'assistant']);
export const MAX_MESSAGE_CHARS = 20_000;

export function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS
    ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…[truncated ${text.length - MAX_MESSAGE_CHARS} chars]`
    : text;
}

/** Content is a string, or an array of typed parts. Both shapes appear. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part !== null && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

/**
 * An assistant turn can surface in more than one stream of the same transcript.
 * Collapse on (role, content) rather than picking a stream, because which
 * stream carries a given turn is not consistent across sessions — a lesson from
 * Codex, where the only copy of the work-graph conclusion lived in the stream
 * the first parser dropped.
 */
export function dedupeMessages(messages: CapturedMessage[]): CapturedMessage[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    const key = `${m.role}${m.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// codex
// ─────────────────────────────────────────────────────────────────────────────

const CODEX_ROOT = path.join(homedir(), '.codex', 'sessions');

function walkRollouts(dir: string, sinceMs: number, out: DiscoveredSession[] = []): DiscoveredSession[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkRollouts(full, sinceMs, out);
      continue;
    }
    if (!name.endsWith('.jsonl') || !name.startsWith('rollout-')) continue;
    if (st.mtimeMs < sinceMs) continue;
    out.push({ path: full, mtimeMs: st.mtimeMs });
  }
  return out;
}

export const codexAdapter = {
  id: 'codex',
  source: 'codex',
  detect: () => existsSync(CODEX_ROOT),
  discover: (sinceMs: number) => walkRollouts(CODEX_ROOT, sinceMs),

  /**
   * STREAMED, not read whole. readFileSync fails on 137 of 2,833 rollouts with
   * Node's ~512MB string cap; the largest here is 10GB. Those files are large
   * BECAUSE they hold long working sessions, so a whole-file read succeeds on
   * every trivial session and silently drops the most substantial work — a
   * failure correlated with value, which is the worst kind.
   */
  async parse(file: DiscoveredSession) {
    const messages = [];
    const toolsUsed = new Set<string>();
    let meta = null;
    let firstTs = null;
    let lastTs = null;

    const rl = createInterface({
      input: createReadStream(String(file['path']), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // a torn line must not lose the rest of the session
      }

      const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      if (ts !== null) {
        if (firstTs === null) firstTs = ts;
        lastTs = ts;
      }

      const payload = entry.payload;
      if (payload === null || typeof payload !== 'object') continue;

      if (entry.type === 'session_meta' && meta === null) {
        meta = {
          id: typeof payload.id === 'string' ? payload.id : null,
          cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
          originator: typeof payload.originator === 'string' ? payload.originator : null,
          cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : null,
        };
        continue;
      }

      // event_msg/agent_message is the rendered text the user sees, and it is
      // NOT always duplicated into a response_item. The 2026-07-21 work-graph
      // conclusion exists ONLY here.
      if (entry.type === 'event_msg') {
        if (payload.type !== 'agent_message') continue;
        const text = extractText(payload.message ?? payload.text ?? payload.content).trim();
        if (text === '') continue;
        messages.push({ role: 'assistant', content: truncate(text), timestamp: ts ?? new Date().toISOString() });
        continue;
      }

      if (entry.type !== 'response_item') continue;

      if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        if (typeof payload.name === 'string') toolsUsed.add(payload.name);
        continue;
      }

      const isAgent = payload.type === 'agent_message';
      if (payload.type !== 'message' && !isAgent) continue;
      const role = isAgent ? 'assistant' : (typeof payload.role === 'string' ? payload.role : '');
      if (!FORWARDED_ROLES.has(role)) continue; // 'developer' is system scaffolding

      const text = extractText(payload.content).trim();
      if (text === '') continue;
      messages.push({ role, content: truncate(text), timestamp: ts ?? new Date().toISOString() });
    }

    if (meta === null || messages.length === 0) return null;
    const deduped = dedupeMessages(messages);

    return {
      session_key: `codex:${meta.id ?? path.basename(String(file['path']), '.jsonl')}`,
      source: 'codex',
      project_slug: meta.cwd !== null ? path.basename(meta.cwd) : undefined,
      cwd: meta.cwd ?? undefined,
      messages: deduped,
      tools_used: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
      message_count: deduped.length,
      session_started_at: firstTs ?? undefined,
      session_ended_at: lastTs ?? undefined,
      metadata: {
        originator: meta.originator,
        cli_version: meta.cliVersion,
        cwd: meta.cwd,
        rollout_file: path.basename(String(file['path'])),
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// cursor
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_ROOT = path.join(homedir(), '.cursor', 'projects');

export const cursorAdapter = {
  id: 'cursor',
  source: 'cursor',
  detect: () => existsSync(CURSOR_ROOT),

  discover(sinceMs: number) {
    const out = [];
    for (const projectDir of readdirSync(CURSOR_ROOT)) {
      const agentRoot = path.join(CURSOR_ROOT, projectDir, 'agent-transcripts');
      if (!existsSync(agentRoot)) continue;
      for (const sessionDir of readdirSync(agentRoot)) {
        const full = path.join(agentRoot, sessionDir, `${sessionDir}.jsonl`);
        if (!existsSync(full)) continue;
        const st = statSync(full);
        if (st.mtimeMs < sinceMs) continue;
        out.push({ path: full, mtimeMs: st.mtimeMs, projectDir, sessionId: sessionDir });
      }
    }
    return out;
  },

  async parse(file: DiscoveredSession) {
    const messages = [];
    for (const line of readFileSync(String(file['path']), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const role = typeof entry.role === 'string' ? entry.role : '';
      if (!FORWARDED_ROLES.has(role)) continue;
      const text = extractText(entry.message).trim();
      if (text === '') continue;
      messages.push({ role, content: truncate(text), timestamp: new Date(Number(file['mtimeMs'])).toISOString() });
    }
    if (messages.length === 0) return null;

    // Cursor flattens the absolute path (Users-galenoakes-Development-Parlor);
    // the trailing segment matches the basename other sources produce, so work
    // lands against one project rather than a per-tool duplicate.
    const segments = String(file['projectDir']).split('-');
    return {
      session_key: `cursor:${file['sessionId']}`,
      source: 'cursor',
      project_slug: segments[segments.length - 1] ?? String(file['projectDir']),
      messages,
      message_count: messages.length,
      session_ended_at: new Date(Number(file['mtimeMs'])).toISOString(),
      metadata: { project_dir: String(file['projectDir']) },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// opencode
//
// SQLite rather than files: session / message / part, where message.data and
// part.data are JSON blobs. Zero rows on this machine as of 2026-07-27 —
// installed, not yet used. The adapter ships anyway so the first real session is
// captured without anyone remembering to wire it up.
//
// Read-only, and via the sqlite3 CLI rather than a driver dependency: this
// script must stay runnable from a bare launchd job with no install step.
// ─────────────────────────────────────────────────────────────────────────────

const OPENCODE_DB = path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

function sqlite(db: string, sql: string): Record<string, unknown>[] {
  try {
    const out = execFileSync('sqlite3', ['-json', '-readonly', db, sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
    return out === '' ? [] : JSON.parse(out);
  } catch {
    return [];
  }
}

export const opencodeAdapter = {
  id: 'opencode',
  source: 'opencode',
  detect: () => existsSync(OPENCODE_DB),

  discover(sinceMs: number) {
    const sinceSec = Math.floor(sinceMs / 1000);
    // time_* are epoch values; compare in both ms and s since the unit is not
    // documented and an empty table gave nothing to measure against.
    return sqlite(
      OPENCODE_DB,
      `SELECT s.id, s.directory, s.title, MAX(m.time_updated) AS last_ms
         FROM session s JOIN message m ON m.session_id = s.id
        GROUP BY s.id
       HAVING COALESCE(last_ms,0) > ${sinceSec}`,
    ).map((row) => ({
      sessionId: row.id,
      directory: row.directory,
      title: row.title,
      mtimeMs: Number(row.last_ms) > 1e12 ? Number(row.last_ms) : Number(row.last_ms) * 1000,
    }));
  },

  async parse(file: DiscoveredSession) {
    const rows = sqlite(
      OPENCODE_DB,
      `SELECT data, time_created FROM message
        WHERE session_id = '${String(file['sessionId']).replace(/'/g, "''")}'
        ORDER BY time_created ASC`,
    );

    const messages = [];
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        continue;
      }
      const role = typeof data.role === 'string' ? data.role : '';
      if (!FORWARDED_ROLES.has(role)) continue;
      const text = extractText(data.content ?? data.text ?? data.parts).trim();
      if (text === '') continue;
      messages.push({
        role,
        content: truncate(text),
        timestamp: new Date(Number(row.time_created) > 1e12
          ? Number(row.time_created)
          : Number(row.time_created) * 1000).toISOString(),
      });
    }
    if (messages.length === 0) return null;

    return {
      session_key: `opencode:${file['sessionId']}`,
      source: 'opencode',
      project_slug:
        typeof file['directory'] === 'string' ? path.basename(file['directory']) : undefined,
      cwd: typeof file['directory'] === 'string' ? file['directory'] : undefined,
      messages,
      message_count: messages.length,
      session_ended_at: new Date(Number(file['mtimeMs'])).toISOString(),
      metadata: { title: file['title'], directory: file['directory'] },
    };
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// grok (xAI Grok Build / Grok CLI)
//
// Sessions live at ~/.grok/sessions/<url-encoded-cwd>/<session-id>/ with:
//   chat_history.jsonl  — durable turns (type: system|user|assistant|reasoning|tool_result)
//   summary.json        — id, cwd, title, timestamps, model
//   events.jsonl        — tool_started / tool_completed (tool names only; not bulk)
//
// Like codex: not captured by Claude Code hooks. Grok has its own hook system and
// can load Claude settings, but the Claude hooks use snake_case field names and
// hardcode source=claude_code, so live hook capture is a separate gap. This
// adapter makes every Grok session on disk visible the same way codex is.
// ─────────────────────────────────────────────────────────────────────────────

const GROK_ROOT = path.join(homedir(), '.grok', 'sessions');

function decodeGrokPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isSyntheticGrokUser(entry: Record<string, unknown>): boolean {
  // Grok injects system-reminder / user_info blocks as type=user with synthetic_reason.
  if (typeof entry.synthetic_reason === 'string' && entry.synthetic_reason !== '') return true;
  const text = extractText(entry.content).trim();
  if (text === '') return true;
  // Scaffold-only lines (no real <user_query>) are not conversational content.
  if (text.includes('<user_info>') && !text.includes('<user_query>')) return true;
  if (text.startsWith('<system-reminder>') || text.includes('\n<system-reminder>')) {
    if (!text.includes('<user_query>')) return true;
  }
  return false;
}

/** Prefer the human-readable <user_query> body when present. */
function grokUserText(entry: Record<string, unknown>): string {
  const raw = extractText(entry.content).trim();
  const m = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (m !== null && m[1].trim() !== '') return m[1].trim();
  return raw;
}

export const grokAdapter: SessionAdapter = {
  id: 'grok',
  source: 'grok',
  detect: () => existsSync(GROK_ROOT),

  discover(sinceMs: number) {
    const out: DiscoveredSession[] = [];
    if (!existsSync(GROK_ROOT)) return out;
    for (const cwdEnc of readdirSync(GROK_ROOT)) {
      const cwdDir = path.join(GROK_ROOT, cwdEnc);
      let st;
      try {
        st = statSync(cwdDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const sessionId of readdirSync(cwdDir)) {
        const sessionDir = path.join(cwdDir, sessionId);
        const history = path.join(sessionDir, 'chat_history.jsonl');
        if (!existsSync(history)) continue;
        let histSt;
        try {
          histSt = statSync(history);
        } catch {
          continue;
        }
        if (histSt.mtimeMs < sinceMs) continue;
        out.push({
          path: history,
          sessionDir,
          sessionId,
          cwdEncoded: cwdEnc,
          mtimeMs: histSt.mtimeMs,
        });
      }
    }
    return out;
  },

  async parse(file: DiscoveredSession) {
    const messages: CapturedMessage[] = [];
    const toolsUsed = new Set<string>();
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    // summary.json is small and authoritative for id/cwd/times when present.
    let summary: Record<string, unknown> | null = null;
    const summaryPath = path.join(String(file['sessionDir']), 'summary.json');
    if (existsSync(summaryPath)) {
      try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
      } catch {
        summary = null;
      }
    }

    if (summary !== null) {
      if (typeof summary.created_at === 'string') firstTs = summary.created_at;
      if (typeof summary.updated_at === 'string') lastTs = summary.updated_at;
      else if (typeof summary.last_active_at === 'string') lastTs = summary.last_active_at;
    }

    // Tool names from the events stream when available (cheap; not the bulk output).
    const eventsPath = path.join(String(file['sessionDir']), 'events.jsonl');
    if (existsSync(eventsPath)) {
      try {
        for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (entry.type === 'tool_started' || entry.type === 'tool_completed') {
            const name = typeof entry.tool_name === 'string'
              ? entry.tool_name
              : (typeof entry.name === 'string' ? entry.name : null);
            if (name !== null) toolsUsed.add(name);
          }
        }
      } catch {
        // events are optional enrichment
      }
    }

    const rl = createInterface({
      input: createReadStream(String(String(file['path'])), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const kind = typeof entry.type === 'string' ? entry.type : '';
      // Skip system scaffolding, reasoning traces, and tool OUTPUT bulk.
      if (kind === 'system' || kind === 'reasoning' || kind === 'tool_result') continue;

      // Tool names may also live on assistant turns.
      if (kind === 'assistant' && Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          if (tc !== null && typeof tc === 'object' && typeof (tc as { name?: unknown }).name === 'string') {
            toolsUsed.add((tc as { name: string }).name);
          }
        }
      }

      let role = '';
      let text = '';
      if (kind === 'user') {
        if (isSyntheticGrokUser(entry)) continue;
        role = 'user';
        text = grokUserText(entry);
      } else if (kind === 'assistant') {
        role = 'assistant';
        text = extractText(entry.content).trim();
      } else {
        continue;
      }

      if (!FORWARDED_ROLES.has(role) || text === '') continue;
      const ts =
        typeof entry.timestamp === 'string'
          ? entry.timestamp
          : (lastTs ?? new Date(Number(file['mtimeMs'])).toISOString());
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
      messages.push({ role, content: truncate(text), timestamp: ts });
    }

    if (messages.length === 0) return null;
    const deduped = dedupeMessages(messages);

    const info = summary !== null && typeof summary.info === 'object' && summary.info !== null
      ? (summary.info as Record<string, unknown>)
      : null;
    const cwd =
      info !== null && typeof info.cwd === 'string'
        ? info.cwd
        : decodeGrokPathSegment(String(file['cwdEncoded'] ?? ''));
    const sessionId =
      info !== null && typeof info.id === 'string'
        ? info.id
        : String(file['sessionId']);

    return {
      session_key: `grok:${sessionId}`,
      source: 'grok',
      project_slug: cwd !== '' ? path.basename(cwd) : undefined,
      cwd: cwd !== '' ? cwd : undefined,
      messages: deduped,
      tools_used: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
      message_count: deduped.length,
      session_started_at: firstTs ?? undefined,
      session_ended_at: lastTs ?? new Date(Number(file['mtimeMs'])).toISOString(),
      metadata: {
        cwd: cwd !== '' ? cwd : undefined,
        title:
          summary !== null && typeof summary.generated_title === 'string'
            ? summary.generated_title
            : (summary !== null && typeof summary.session_summary === 'string'
              ? summary.session_summary
              : undefined),
        model:
          summary !== null && typeof summary.current_model_id === 'string'
            ? summary.current_model_id
            : undefined,
        agent_name:
          summary !== null && typeof summary.agent_name === 'string'
            ? summary.agent_name
            : undefined,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// claude-code (local JSONL transcripts)
//
// WHY THIS EXISTS DESPITE THE HOOKS
// ---------------------------------
// The hooks are live and they work, and they are not complete. Measured
// 2026-08-18: 4,452 of 9,197 claude_code sessions (48%) have any stored message
// body at all, and `coding_sessions.message_count` sums to ~2.4M against ~225k
// stored rows. The hooks capture what happens while they are installed and
// firing; a session that predates them, ran on a machine without them, or lost
// a curl to a network blip leaves a session row with no conversation in it.
// The transcript on disk has the whole thing.
//
// LAYOUT, MEASURED ON THIS MACHINE 2026-08-18
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl          347 files  <- these
//   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/*.jsonl  2,854  <- NOT these
//   ~/.claude/projects/<encoded-cwd>/<sessionId>/workflows/*.json
// Only the top-level `<sessionId>.jsonl` is the session. The `subagents/`
// siblings are one file per Task-tool subagent, and their user turns are the
// ORCHESTRATOR's briefs, not a person's — ingesting them would pour thousands
// of agent-written prompts into the founder corpus wearing role='user'. Hence
// depth-1 discovery, never a recursive walk.
//
// Retention is ~30 days (2.9 GB here, 2026-07-19 → 08-18), so this adapter
// backfills a rolling recent window and the database stays the fuller record
// for anything older. That asymmetry is the reason `claudeHistoryAdapter`
// below exists as well.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_ROOT = path.join(homedir(), '.claude', 'projects');

/** Transient notices Claude Code writes as assistant turns. Not conversation. */
function isTransientAssistantNotice(text: string): boolean {
  if (text.startsWith('API Error:')) return true;
  if (text.includes('temporarily limiting requests')) return true;
  return false;
}

/**
 * Assistant text, exactly as `session-assistant-messages.sh` computes it:
 * the `text` parts of `message.content`, joined by newline. `thinking` and
 * `tool_use` parts are deliberately dropped — matching the hook matters more
 * than completeness here, because a different answer means a different
 * `turn_index` and a duplicated row.
 */
function claudeAssistantText(entry: Record<string, unknown>): string {
  const message = entry['message'];
  if (message === null || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return extractText(content).trim();
  return content
    .map((part) => {
      if (part === null || typeof part !== 'object') return '';
      const typed = part as Record<string, unknown>;
      if (typed['type'] !== 'text') return '';
      return typeof typed['text'] === 'string' ? typed['text'] : '';
    })
    .filter((t) => t !== '')
    .join('\n')
    .trim();
}

/**
 * User text. `type: 'user'` covers both what the person typed AND every
 * `tool_result` the runtime feeds back, which is the bulk of them. Only the
 * string form and `text` parts are conversation.
 */
function claudeUserText(entry: Record<string, unknown>): string {
  if (entry['isMeta'] === true) return '';
  const message = entry['message'];
  if (message === null || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part === null || typeof part !== 'object') return '';
      const typed = part as Record<string, unknown>;
      if (typed['type'] !== 'text') return ''; // tool_result, image, …
      return typeof typed['text'] === 'string' ? typed['text'] : '';
    })
    .filter((t) => t !== '')
    .join('\n')
    .trim();
}

export const claudeAdapter: SessionAdapter = {
  id: 'claude',
  source: 'claude_code',
  // Backfill onto hook-owned session rows. See SessionAdapter.postsSession.
  postsSession: false,
  detect: () => existsSync(CLAUDE_PROJECTS_ROOT),

  discover(sinceMs: number) {
    const out: DiscoveredSession[] = [];
    if (!existsSync(CLAUDE_PROJECTS_ROOT)) return out;
    for (const projectDir of readdirSync(CLAUDE_PROJECTS_ROOT)) {
      const dir = path.join(CLAUDE_PROJECTS_ROOT, projectDir);
      let dirStat;
      try {
        dirStat = statSync(dir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const full = path.join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        // Depth 1 only. A `<sessionId>/` directory is skipped here by virtue of
        // not ending in `.jsonl`; its subagent transcripts are never reached.
        if (!st.isFile()) continue;
        if (st.mtimeMs < sinceMs) continue;
        out.push({
          path: full,
          mtimeMs: st.mtimeMs,
          projectDir,
          sessionId: name.slice(0, -'.jsonl'.length),
        });
      }
    }
    return out;
  },

  /**
   * STREAMED. The largest transcript on this machine is 60 MB and several
   * exceed Node's string cap when concatenated; the codex adapter learned this
   * the expensive way (whole-file reads succeeded on every trivial session and
   * dropped the substantial ones).
   */
  async parse(file: DiscoveredSession) {
    const messages: CapturedMessage[] = [];
    const toolsUsed = new Set<string>();
    let cwd: string | null = null;
    let sessionIdFromFile: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    // Two independent ordinal namespaces, both counting EVERY entry of their
    // role including the ones that produce no row. See CapturedMessage.turn_index.
    let assistantOrdinal = -1;
    let userOrdinal = -1;

    const rl = createInterface({
      input: createReadStream(String(file['path']), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // a torn line must not lose the rest of the session
      }

      if (cwd === null && typeof entry['cwd'] === 'string' && entry['cwd'] !== '') {
        cwd = entry['cwd'];
      }
      if (sessionIdFromFile === null && typeof entry['sessionId'] === 'string') {
        sessionIdFromFile = entry['sessionId'];
      }

      const kind = typeof entry['type'] === 'string' ? entry['type'] : '';
      if (kind !== 'user' && kind !== 'assistant') continue;

      // A sidechain entry is a subagent turn spliced into the main transcript
      // by older Claude Code builds. Same reason the subagents/ directory is
      // skipped: those user turns are an orchestrator's, not a person's.
      if (entry['isSidechain'] === true) continue;

      const ts = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null;

      if (kind === 'assistant') {
        assistantOrdinal += 1;
        const message = entry['message'];
        if (message !== null && typeof message === 'object') {
          const content = (message as Record<string, unknown>)['content'];
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part === null || typeof part !== 'object') continue;
              const typed = part as Record<string, unknown>;
              if (typed['type'] === 'tool_use' && typeof typed['name'] === 'string') {
                toolsUsed.add(typed['name']);
              }
            }
          }
        }
        const text = claudeAssistantText(entry);
        if (text === '' || isTransientAssistantNotice(text)) continue;
        if (ts !== null) {
          if (firstTs === null) firstTs = ts;
          lastTs = ts;
        }
        messages.push({
          role: 'assistant',
          content: truncate(text),
          timestamp: ts ?? new Date(Number(file['mtimeMs'])).toISOString(),
          turn_index: assistantOrdinal,
          metadata: { ingest: 'claude_jsonl' },
        });
        continue;
      }

      userOrdinal += 1;
      const text = claudeUserText(entry);
      if (text === '') continue;
      if (ts !== null) {
        if (firstTs === null) firstTs = ts;
        lastTs = ts;
      }
      messages.push({
        role: 'user',
        content: truncate(text),
        timestamp: ts ?? new Date(Number(file['mtimeMs'])).toISOString(),
        turn_index: userOrdinal,
        metadata: { ingest: 'claude_jsonl' },
      });
    }

    if (messages.length === 0) return null;
    const deduped = dedupeMessages(messages);
    const sessionId = sessionIdFromFile ?? String(file['sessionId']);

    return {
      // `claude:<uuid>` — the key `~/.claude/hooks/lib/session-key.sh` resolves
      // and the only key `coding_sessions` carries for this source. Backfill has
      // to land on the EXISTING session rows; a second key form would mint twins,
      // which is exactly the defect that hook fixed on 2026-08-16.
      session_key: `claude:${sessionId}`,
      source: 'claude_code',
      project_slug: cwd !== null ? path.basename(cwd) : undefined,
      cwd: cwd ?? undefined,
      messages: deduped,
      tools_used: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
      message_count: deduped.length,
      session_started_at: firstTs ?? undefined,
      session_ended_at: lastTs ?? new Date(Number(file['mtimeMs'])).toISOString(),
      metadata: {
        ingest: 'claude_jsonl',
        transcript_file: path.basename(String(file['path'])),
        project_dir: String(file['projectDir']),
        cwd,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// claude-history (~/.claude/history.jsonl)
//
// One line per prompt the person actually typed, across every project, going
// back further than the transcripts do: 5,370 rows, 2026-07-09 → 08-17, ~472k
// chars, and — uniquely on this machine — ZERO machine markers. No
// task-notification, no system-reminder, no compaction summary. It is the
// purest channel of G's own words the fleet has.
//
// It exists as its own adapter because a session whose transcript has aged out
// of the 30-day window still has its prompts here. Without this, three months of
// direction is recoverable only for the last thirty days of it.
//
// Row shape: { display, pastedContents, timestamp (epoch ms), project, sessionId }
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_HISTORY_FILE = path.join(homedir(), '.claude', 'history.jsonl');

/**
 * `turn_index` offset for history rows.
 *
 * Both this adapter and `claudeAdapter` write role='user' under the same
 * `claude:<uuid>` key, and their ordinals are NOT the same sequence — the
 * transcript counts tool_result entries that never appear here. Numbered from
 * zero they would upsert over each other on `(session_key, role, turn_index)`
 * and one channel would silently overwrite the other. A disjoint namespace is
 * how `session-event.sh` already keeps its tool rows apart (it uses 1,000,000);
 * 2,000,000 keeps this clear of both.
 */
export const CLAUDE_HISTORY_TURN_OFFSET = 2_000_000;

/** `/login`, `/clear` — a command, not a thing he said. */
function isBareSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*$/.test(text.trim());
}

interface HistoryRow {
  display: string;
  timestamp: number;
  project: string;
}

export const claudeHistoryAdapter: SessionAdapter = {
  id: 'claude-history',
  source: 'claude_code',
  // Backfill onto hook-owned session rows. See SessionAdapter.postsSession.
  // This one is the sharpest case: its message_count is the typed-prompt count,
  // and the webhook would write it over the session's real one.
  postsSession: false,
  detect: () => existsSync(CLAUDE_HISTORY_FILE),

  discover(sinceMs: number) {
    if (!existsSync(CLAUDE_HISTORY_FILE)) return [];
    const bySession = new Map<string, HistoryRow[]>();
    for (const line of readFileSync(CLAUDE_HISTORY_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sessionId = typeof entry['sessionId'] === 'string' ? entry['sessionId'] : '';
      const display = typeof entry['display'] === 'string' ? entry['display'] : '';
      if (sessionId === '' || display.trim() === '') continue;
      const rows = bySession.get(sessionId) ?? [];
      rows.push({
        display,
        timestamp: typeof entry['timestamp'] === 'number' ? entry['timestamp'] : 0,
        project: typeof entry['project'] === 'string' ? entry['project'] : '',
      });
      bySession.set(sessionId, rows);
    }

    const out: DiscoveredSession[] = [];
    for (const [sessionId, rows] of bySession) {
      // The ordinal is assigned over ALL rows of the session, so a session is
      // offered whole or not at all. Filtering rows by `since` would renumber
      // the survivors and land them on someone else's turn_index.
      const newest = rows.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), 0);
      if (newest < sinceMs) continue;
      out.push({ sessionId, rows, mtimeMs: newest });
    }
    return out;
  },

  async parse(file: DiscoveredSession) {
    const rows = file['rows'] as HistoryRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const messages: CapturedMessage[] = [];
    let project = '';
    let ordinal = -1;
    for (const row of rows) {
      ordinal += 1;
      if (project === '' && row.project !== '') project = row.project;
      const display = row.display.trim();
      if (display === '' || isBareSlashCommand(display)) continue;
      messages.push({
        role: 'user',
        content: truncate(display),
        timestamp:
          row.timestamp > 0 ? new Date(row.timestamp).toISOString() : new Date(Number(file['mtimeMs'])).toISOString(),
        turn_index: CLAUDE_HISTORY_TURN_OFFSET + ordinal,
        metadata: { ingest: 'claude_history' },
      });
    }
    if (messages.length === 0) return null;

    const timestamps = rows.map((r) => r.timestamp).filter((t) => t > 0);
    return {
      session_key: `claude:${file['sessionId']}`,
      source: 'claude_code',
      project_slug: project !== '' ? path.basename(project) : undefined,
      cwd: project !== '' ? project : undefined,
      messages,
      message_count: messages.length,
      session_started_at:
        timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : undefined,
      session_ended_at:
        timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : undefined,
      metadata: { ingest: 'claude_history', project },
    };
  },
};

/**
 * Every adapter. Order is display order only.
 *
 * `claude` and `claude-history` were absent until 2026-08-18 on the reasoning
 * that the hooks already capture Claude Code. That was true of what the hooks
 * SEE and false of the corpus: 48% of claude_code sessions had no stored body,
 * and `~/.claude/history.jsonl` — the cleanest channel of typed direction on
 * the machine — had no reader at all. Both write onto the hooks' own
 * `claude:<uuid>` keys, so this is backfill, not a second producer.
 *
 * DELIBERATELY ABSENT:
 *  - gemini-cli: `~/.gemini` holds config and credentials, no transcripts.
 *    Recorded here so nobody re-checks.
 *  - antigravity: 7 conversations in protobuf (`.pb`). Needs a schema we do not
 *    have; the volume does not currently justify reverse-engineering one.
 *  - `~/.claude/projects/<sessionId>/subagents/*.jsonl`: 2,854 files whose
 *    role='user' turns are orchestrator briefs. Not a person.
 */
export const ADAPTERS: SessionAdapter[] = [
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
  grokAdapter,
  claudeAdapter,
  claudeHistoryAdapter,
];
