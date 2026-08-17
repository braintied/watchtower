/**
 * Session-capture adapters — one per agent/IDE.
 *
 * WHY AN ADAPTER REGISTRY AND NOT A SCRIPT PER TOOL
 * -------------------------------------------------
 * Watchtower's original capture was Claude Code only, because its hooks fire
 * from Claude Code's own lifecycle. Everything else was invisible. A day's
 * sessions then contained none of the work-graph identity another audit had
 * already asked for, and a second pass re-derived the same conclusion because
 * the first finding lived somewhere nothing could read.
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

    // Cursor flattens the absolute path (Users-alice-src-my-app);
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

/**
 * Every adapter. Order is display order only.
 *
 * DELIBERATELY ABSENT:
 *  - claude-code: already captured by `~/.claude/hooks`. A second producer would
 *    double-write the corpus that already works.
 *  - gemini-cli: `~/.gemini` holds config and credentials, no transcripts.
 *    Recorded here so nobody re-checks.
 *  - antigravity: 7 conversations in protobuf (`.pb`). Needs a schema we do not
 *    have; the volume does not currently justify reverse-engineering one.
 */
export const ADAPTERS: SessionAdapter[] = [codexAdapter, cursorAdapter, opencodeAdapter, grokAdapter];
