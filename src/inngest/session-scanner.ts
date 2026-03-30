/**
 * Watchtower: Session Scanner
 *
 * CRON-triggered function that scans ~/.claude/projects/ for Claude Code
 * sessions and ingests them into watchtower.coding_sessions.
 *
 * For each session directory:
 * 1. Read JSONL files from subagents/
 * 2. Extract messages, tool usage, files touched
 * 3. Calculate duration, message count, etc.
 * 4. Insert into coding_sessions table
 * 5. Emit watchtower/coding-session.received event
 */

import type { Inngest } from 'inngest';
import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CRON_SCHEDULES } from '../config.js';
import { queryWatchtower } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { redactSecrets } from '../lib/redact.js';

// =============================================================================
// TYPES
// =============================================================================

interface JsonlUserMessage {
  [key: string]: unknown;
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
  timestamp: string;
  cwd: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: {
    file_path?: string;
    [key: string]: unknown;
  };
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

interface JsonlAssistantMessage {
  [key: string]: unknown;
  type: 'assistant';
  message: {
    model: string;
    content: ContentBlock[];
  };
  timestamp: string;
}

interface ToolCall {
  name: string;
  summary: string;
}

interface ParsedMessage {
  role: string;
  timestamp: string;
  content: string;
  toolNames: string[];
  filePaths: string[];
  toolCalls: ToolCall[];
}

// =============================================================================
// JSONL PARSING
// =============================================================================

/**
 * Type guard for JSONL entries with user messages.
 */
function isUserEntry(entry: Record<string, unknown>): entry is JsonlUserMessage {
  return entry.type === 'user'
    && entry.message !== null
    && entry.message !== undefined
    && typeof entry.timestamp === 'string';
}

/**
 * Type guard for JSONL entries with assistant messages.
 */
function isAssistantEntry(entry: Record<string, unknown>): entry is JsonlAssistantMessage {
  return entry.type === 'assistant'
    && entry.message !== null
    && entry.message !== undefined
    && typeof entry.timestamp === 'string';
}

/**
 * Check if a content block is a tool_use block.
 */
function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/**
 * File-modifying tool names used to track files touched.
 */
const FILE_TOOL_NAMES = new Set(['Edit', 'Write', 'Read']);

/**
 * Summarize a tool call input into a compact string.
 * Captures the essence of what the tool did without full content.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const filePath = typeof input.file_path === 'string' ? input.file_path : null;

  switch (name) {
    case 'Edit': {
      const oldStr = typeof input.old_string === 'string' ? input.old_string.slice(0, 100) : '';
      const newStr = typeof input.new_string === 'string' ? input.new_string.slice(0, 100) : '';
      return filePath !== null
        ? `Edit ${filePath}: "${oldStr}" -> "${newStr}"`
        : `Edit: "${oldStr}" -> "${newStr}"`;
    }
    case 'Write':
      return filePath !== null ? `Write ${filePath}` : 'Write file';
    case 'Read':
      return filePath !== null ? `Read ${filePath}` : 'Read file';
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command.slice(0, 200) : '';
      return `Bash: ${command}`;
    }
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const path = typeof input.path === 'string' ? input.path : '';
      return `Grep "${pattern}" in ${path}`;
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return `Glob "${pattern}"`;
    }
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt.slice(0, 150) : '';
      return `Agent(${desc}): ${prompt}`;
    }
    case 'WebSearch': {
      const query = typeof input.query === 'string' ? input.query : '';
      return `WebSearch: ${query}`;
    }
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : '';
      return `WebFetch: ${url}`;
    }
    default: {
      // Generic: show first key=value pairs
      const entries = Object.entries(input).slice(0, 3);
      const pairs = entries.map(([k, v]) => {
        const valStr = typeof v === 'string' ? v.slice(0, 80) : String(v);
        return `${k}=${valStr}`;
      });
      return `${name}(${pairs.join(', ')})`;
    }
  }
}

/**
 * Parse a single JSONL line into a ParsedMessage.
 * Returns null if the line cannot be parsed or is not a recognized message type.
 */
function parseJsonlLine(line: string): ParsedMessage | null {
  if (line.trim() === '') {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (isUserEntry(parsed)) {
    return {
      role: 'user',
      timestamp: parsed.timestamp,
      content: parsed.message.content,
      toolNames: [],
      filePaths: [],
      toolCalls: [],
    };
  }

  if (isAssistantEntry(parsed)) {
    const toolNames: string[] = [];
    const filePaths: string[] = [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const contentBlocks = parsed.message.content;

    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (block.type === 'text' && 'text' in block) {
          textParts.push((block as TextBlock).text);
        }
        if (isToolUseBlock(block)) {
          toolNames.push(block.name);
          toolCalls.push({
            name: block.name,
            summary: summarizeToolInput(block.name, block.input),
          });
          if (FILE_TOOL_NAMES.has(block.name)) {
            const filePath = block.input.file_path;
            if (typeof filePath === 'string' && filePath.length > 0) {
              filePaths.push(filePath);
            }
          }
        }
      }
    }

    return {
      role: 'assistant',
      timestamp: parsed.timestamp,
      content: textParts.join('\n'),
      toolNames,
      filePaths,
      toolCalls,
    };
  }

  return null;
}

// =============================================================================
// DIRECTORY SCANNING
// =============================================================================

/**
 * UUID v4 pattern for identifying session directories.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a directory name looks like a UUID (session directory).
 */
function isUuidDirName(name: string): boolean {
  return UUID_PATTERN.test(name);
}

/**
 * Convert a Claude project directory name back to a filesystem path.
 * e.g. "-Users-galenoakes-Development-project-name" -> "/Users/galenoakes/Development/project-name"
 */
function dirNameToPath(dirName: string): string {
  // Replace leading dash with /, then replace remaining dashes with /
  // But only dashes that were originally path separators
  // The convention is: replace all / with - and prepend -
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * List subdirectories of a given path.
 * Returns empty array if the path doesn't exist or can't be read.
 */
async function listSubdirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Read all JSONL files from a session's subagents directory.
 */
async function readSessionJsonlFiles(sessionDir: string): Promise<string[]> {
  const subagentsDir = join(sessionDir, 'subagents');
  const lines: string[] = [];

  try {
    const files = await readdir(subagentsDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      try {
        const content = await readFile(join(subagentsDir, file), 'utf-8');
        const cleaned = content.replace(/^\uFEFF/, '');
        for (const line of cleaned.split('\n')) {
          if (line.trim().length > 0) {
            lines.push(line);
          }
        }
      } catch (readErr) {
        const errMsg = readErr instanceof Error ? readErr.message : 'Unknown error';
        logger.warn({ file, error: errMsg }, '[SessionScanner] Failed to read JSONL file');
      }
    }
  } catch {
    // subagents/ directory may not exist — that's fine
  }

  // Also check for a top-level session JSONL file
  try {
    const topLevelFiles = await readdir(sessionDir);
    for (const file of topLevelFiles) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      try {
        const content = await readFile(join(sessionDir, file), 'utf-8');
        const cleaned = content.replace(/^\uFEFF/, '');
        for (const line of cleaned.split('\n')) {
          if (line.trim().length > 0) {
            lines.push(line);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip if can't read session dir
  }

  return lines;
}

/**
 * Read session memory summary if it exists.
 */
async function readSessionSummary(sessionDir: string): Promise<string | null> {
  const summaryPath = join(sessionDir, 'session-memory', 'summary.md');
  try {
    const content = await readFile(summaryPath, 'utf-8');
    return content.replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

export function createSessionScanner(client: Inngest) {
  return client.createFunction(
    {
      id: 'watchtower/session-scanner',
      name: 'Watchtower: Session Scanner',
      concurrency: [{ limit: 1 }],
      retries: 1,
    },
    { cron: CRON_SCHEDULES.session_scanner },
    async ({ step }) => {
      // Step 1: Scan for session directories
      const sessionDirs = await step.run('scan-session-dirs', async () => {
        const claudeProjectsDir = join(homedir(), '.claude', 'projects');
        const projectDirNames = await listSubdirectories(claudeProjectsDir);

        const sessions: Array<{ sessionKey: string; sessionDir: string; projectDirName: string }> = [];

        for (const projectDirName of projectDirNames) {
          const projectDir = join(claudeProjectsDir, projectDirName);
          const subDirs = await listSubdirectories(projectDir);

          for (const subDir of subDirs) {
            if (isUuidDirName(subDir)) {
              sessions.push({
                sessionKey: `${projectDirName}/${subDir}`,
                sessionDir: join(projectDir, subDir),
                projectDirName,
              });
            }
          }
        }

        logger.info(
          { projectCount: projectDirNames.length, sessionCount: sessions.length },
          '[SessionScanner] Scanned session directories',
        );

        return sessions;
      });

      if (sessionDirs.length === 0) {
        return { status: 'complete', sessions_found: 0, sessions_ingested: 0, sessions_skipped: 0 };
      }

      // Step 2: Check for already-ingested sessions
      const existingKeysArr = await step.run('check-existing', async () => {
        const allKeys = sessionDirs.map((s) => s.sessionKey);
        const existing: string[] = [];
        const batchSize = 100;

        for (let i = 0; i < allKeys.length; i += batchSize) {
          const batch = allKeys.slice(i, i + batchSize);
          const { data, error } = await queryWatchtower('coding_sessions')
            .select('session_key')
            .in('session_key', batch);

          if (error !== null) {
            logger.warn({ error: error.message }, '[SessionScanner] Failed to check existing sessions');
            continue;
          }

          if (data !== null) {
            const rows = data as Array<{ session_key: string }>;
            for (const row of rows) {
              existing.push(row.session_key);
            }
          }
        }

        return existing;
      });

      const existingKeys = new Set(existingKeysArr);

      // Filter to new sessions only
      const newSessions = sessionDirs.filter((s) => !existingKeys.has(s.sessionKey));

      logger.info(
        { total: sessionDirs.length, new: newSessions.length, skipped: sessionDirs.length - newSessions.length },
        '[SessionScanner] Filtered to new sessions',
      );

      // Step 4: Ingest each new session
      let sessionsIngested = 0;

      for (const session of newSessions) {
        const ingested = await step.run(`ingest-session-${session.sessionKey.replace(/\//g, '-').slice(0, 60)}`, async () => {
          // Read JSONL files
          const rawLines = await readSessionJsonlFiles(session.sessionDir);
          if (rawLines.length === 0) {
            logger.debug({ sessionKey: session.sessionKey }, '[SessionScanner] No JSONL data found, skipping');
            return false;
          }

          // Parse messages
          const messages: ParsedMessage[] = [];
          for (const line of rawLines) {
            const parsed = parseJsonlLine(line);
            if (parsed !== null) {
              messages.push(parsed);
            }
          }

          if (messages.length === 0) {
            return false;
          }

          // Read session summary and redact secrets
          let summaryContent = await readSessionSummary(session.sessionDir);
          if (summaryContent !== null) {
            const { redacted, redactionCount } = redactSecrets(summaryContent);
            summaryContent = redacted;
            if (redactionCount > 0) {
              logger.info({ sessionKey: session.sessionKey, redactionCount }, '[SessionScanner] Redacted secrets from session summary');
            }
          }

          // Calculate metrics
          const messageCount = messages.length;

          // Duration: first to last timestamp
          const timestamps = messages
            .map((m) => new Date(m.timestamp).getTime())
            .filter((t) => !Number.isNaN(t))
            .sort((a, b) => a - b);

          let durationMinutes = 0;
          let sessionStartedAt: string | null = null;
          let sessionEndedAt: string | null = null;

          if (timestamps.length >= 2) {
            const firstTimestamp = timestamps[0];
            const lastTimestamp = timestamps[timestamps.length - 1];
            durationMinutes = Math.round((lastTimestamp - firstTimestamp) / 60000);
            sessionStartedAt = new Date(firstTimestamp).toISOString();
            sessionEndedAt = new Date(lastTimestamp).toISOString();
          } else if (timestamps.length === 1) {
            sessionStartedAt = new Date(timestamps[0]).toISOString();
            sessionEndedAt = sessionStartedAt;
          }

          // Unique files touched
          const filesTouchedSet = new Set<string>();
          for (const msg of messages) {
            for (const fp of msg.filePaths) {
              filesTouchedSet.add(fp);
            }
          }
          const filesTouched = Array.from(filesTouchedSet);

          // Unique tools used
          const toolsUsedSet = new Set<string>();
          for (const msg of messages) {
            for (const tn of msg.toolNames) {
              toolsUsedSet.add(tn);
            }
          }
          const toolsUsed = Array.from(toolsUsedSet);

          // Derive project name from directory path
          const projectDirPath = dirNameToPath(session.projectDirName);
          const projectSlug = projectDirPath.split('/').pop();

          // Build raw_content for AI analysis (truncated to 50KB)
          // Includes message text + tool call summaries for rich context
          const rawParts: string[] = [];
          let rawLen = 0;
          const maxRawLen = 50000;
          for (const msg of messages) {
            if (rawLen >= maxRawLen) break;

            // Add message text
            if (msg.content.length > 0) {
              const line = `[${msg.role}] ${msg.content}`;
              rawParts.push(line);
              rawLen += line.length;
            }

            // Add tool call summaries (the key technical details)
            for (const tc of msg.toolCalls) {
              if (rawLen >= maxRawLen) break;
              const toolLine = `  > ${tc.summary}`;
              rawParts.push(toolLine);
              rawLen += toolLine.length;
            }

            // If no content and no tool calls, note it
            if (msg.content.length === 0 && msg.toolCalls.length === 0) {
              const emptyLine = `[${msg.role}] (empty)`;
              rawParts.push(emptyLine);
              rawLen += emptyLine.length;
            }
          }
          let rawContent = rawParts.join('\n').slice(0, maxRawLen);

          // Redact secrets from raw content
          if (rawContent.length > 0) {
            const { redacted: redactedContent, redactionCount: rawRedactions } = redactSecrets(rawContent);
            rawContent = redactedContent;
            if (rawRedactions > 0) {
              logger.info({ sessionKey: session.sessionKey, redactionCount: rawRedactions }, '[SessionScanner] Redacted secrets from raw content');
            }
          }

          // Insert into coding_sessions
          const insertPayload: Record<string, unknown> = {
            session_key: session.sessionKey,
            source: 'claude_code',
            message_count: messageCount,
            duration_minutes: durationMinutes,
            files_touched: filesTouched,
            tools_used: toolsUsed,
            metadata: {
              project_dir_name: session.projectDirName,
              resolved_path: projectDirPath,
              raw_content: rawContent,
              summary: summaryContent,
            },
          };

          if (sessionStartedAt !== null) {
            insertPayload.session_started_at = sessionStartedAt;
          }
          if (sessionEndedAt !== null) {
            insertPayload.session_ended_at = sessionEndedAt;
          }

          const { data: insertedRow, error: insertError } = await queryWatchtower('coding_sessions')
            .insert(insertPayload)
            .select('id')
            .single();

          if (insertError !== null) {
            logger.error(
              { error: insertError.message, sessionKey: session.sessionKey },
              '[SessionScanner] Failed to insert session',
            );
            return false;
          }

          const insertedData = insertedRow as { id: string } | null;
          if (insertedData === null) {
            logger.error({ sessionKey: session.sessionKey }, '[SessionScanner] Insert returned no data');
            return false;
          }

          // Emit event for downstream processing
          await client.send({
            name: 'watchtower/coding-session.received',
            data: {
              session_id: insertedData.id,
              project_slug: projectSlug,
            },
          });

          logger.info(
            {
              sessionKey: session.sessionKey,
              messageCount,
              durationMinutes,
              filesTouched: filesTouched.length,
              toolsUsed: toolsUsed.length,
              projectSlug,
            },
            '[SessionScanner] Ingested session',
          );

          return true;
        });

        if (ingested) {
          sessionsIngested++;
        }
      }

      const sessionsSkipped = sessionDirs.length - newSessions.length;

      logger.info(
        { sessionsFound: sessionDirs.length, sessionsIngested, sessionsSkipped },
        '[SessionScanner] Scan complete',
      );

      return {
        status: 'complete',
        sessions_found: sessionDirs.length,
        sessions_ingested: sessionsIngested,
        sessions_skipped: sessionsSkipped,
      };
    },
  );
}
