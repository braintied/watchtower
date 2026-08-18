/**
 * Shared Watchtower types.
 *
 * Source of truth for coding-session producer ids. The Fly service webhook
 * enum must stay in sync (apps/watchtower session.ts).
 */

export const CODING_SESSION_SOURCES = [
  'claude_code',
  'cursor',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'kulti_meet',
] as const;

export type CodingSessionSource = (typeof CODING_SESSION_SOURCES)[number];

export interface CapturedMessage {
  role: string;
  content: string;
  timestamp: string;
  /**
   * Explicit ordinal, when the adapter must reproduce a numbering some OTHER
   * writer already owns. Omit it and `rowsFromPayload` assigns a per-role
   * ordinal over the rows it keeps, which is right for every source that has
   * no second writer.
   *
   * Claude Code has one. `~/.claude/hooks/session-assistant-messages.sh` writes
   * assistant rows numbered by position among ALL assistant entries in the
   * transcript — empty tool-only turns are skipped but still consume their
   * ordinal. A per-kept-row counter diverges from that on the first tool call
   * and every later row lands on a fresh `(session_key, role, turn_index)`,
   * so the "idempotent" upsert would duplicate the whole conversation.
   */
  turn_index?: number;
  /**
   * Row-level metadata, merged into `session_messages.metadata` by
   * `rowsFromPayload`. For which producer wrote the row (`ingest`), not for
   * session-level facts — those belong on `SessionPayload.metadata`.
   */
  metadata?: Record<string, unknown>;
}

export interface SessionPayload {
  session_key: string;
  source: string;
  /**
   * Adapter's cheap guess: `path.basename(cwd)`. Wrong for worktrees and for
   * any repo whose directory name is not its slug, so `ingest` overwrites it
   * with `resolveProjectSlug(cwd, env)` before POSTing. Kept as the fallback
   * for adapters that cannot report a cwd.
   */
  project_slug?: string;
  /**
   * Working directory the session ran in, when the adapter knows it.
   *
   * Carried so the git-identity resolution can happen at the process boundary
   * (`ingest`, which receives `env`) rather than inside an adapter, which by
   * this package's contract may not read the ambient environment.
   */
  cwd?: string;
  /**
   * Was `cwd` inside a git checkout? Set by `ingest`, never by an adapter —
   * answering it needs the filesystem and `env`.
   *
   * This is the one fact the server cannot obtain. It lets the webhook tell
   * `non_repo` ("real work that belongs to no repository") apart from
   * `unresolved` ("we looked for a project and failed"), which
   * `watchtower.coding_sessions.attribution_status` has needed since migration
   * 006 and never had. Conflating them is why the attribution gap could never
   * be measured: a NULL project_id that might legitimately mean "not repo work"
   * is indistinguishable from a broken attributor.
   *
   * Optional, and `undefined` must never be read as `false` downstream — an
   * older CLI that omits it means "unknown", and defaulting it would relabel
   * those sessions `non_repo` and shrink the very gap this measures.
   */
  cwd_is_repo?: boolean;
  messages: CapturedMessage[];
  tools_used?: string[];
  message_count: number;
  session_started_at?: string;
  session_ended_at?: string;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_WATCHTOWER_URL = 'http://localhost:5003';
