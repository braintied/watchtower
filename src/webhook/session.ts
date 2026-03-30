/**
 * Session Webhook Receiver for Watchtower
 *
 * Accepts session data from external sources (Claude Code hooks, Cursor, etc.)
 * and ingests them into watchtower.coding_sessions.
 *
 * POST /webhooks/session
 */

import { z } from 'zod';
import type { Context } from 'hono';
import { queryWatchtower } from '../lib/db.js';
import { inngest } from '../inngest/client.js';
import { logger } from '../lib/logger.js';
import { redactSecrets } from '../lib/redact.js';

// =============================================================================
// SCHEMA
// =============================================================================

const SessionWebhookMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  timestamp: z.string(),
  tool_name: z.string().optional(),
});

const SessionWebhookSchema = z.object({
  session_key: z.string(),
  source: z.enum(['claude_code', 'cursor', 'codex', 'gemini']).default('claude_code'),
  project_slug: z.string().optional(),
  messages: z.array(SessionWebhookMessageSchema).optional(),
  files_touched: z.array(z.string()).optional(),
  tools_used: z.array(z.string()).optional(),
  duration_minutes: z.number().optional(),
  message_count: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  session_started_at: z.string().optional(),
  session_ended_at: z.string().optional(),
});

// =============================================================================
// TYPES
// =============================================================================

interface ProjectLookupRow {
  id: string;
  slug: string;
}

interface InsertedSessionRow {
  id: string;
}

// =============================================================================
// HANDLER
// =============================================================================

export async function handleSessionWebhook(c: Context): Promise<Response> {
  // Read raw body
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: 'Failed to read request body' }, 400);
  }

  // Parse JSON
  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Validate with Zod
  const parseResult = SessionWebhookSchema.safeParse(jsonBody);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return c.json({ error: 'Validation failed', issues }, 400);
  }

  const body = parseResult.data;

  logger.info(
    { sessionKey: body.session_key, source: body.source, projectSlug: body.project_slug },
    '[Watchtower/SessionWebhook] Received session webhook',
  );

  // Resolve project_id from slug if provided
  let projectId: string | null = null;
  let projectSlug: string | null = null;

  if (body.project_slug !== undefined) {
    const { data, error } = await queryWatchtower('projects')
      .select('id, slug')
      .eq('slug', body.project_slug)
      .maybeSingle();

    if (error !== null) {
      logger.warn(
        { error: error.message, slug: body.project_slug },
        '[Watchtower/SessionWebhook] Failed to resolve project slug',
      );
    } else if (data !== null) {
      const projectRow = data as ProjectLookupRow;
      projectId = projectRow.id;
      projectSlug = projectRow.slug;
    } else {
      logger.warn(
        { slug: body.project_slug },
        '[Watchtower/SessionWebhook] Project slug not found',
      );
    }
  }

  // Compute message_count and derived fields from messages if provided
  let messageCount = body.message_count;
  let filesTouched = body.files_touched;
  let toolsUsed = body.tools_used;
  let durationMinutes = body.duration_minutes;

  const messages = body.messages;
  if (messages !== undefined && messages.length > 0) {
    // Derive message_count if not explicitly provided
    if (messageCount === undefined) {
      messageCount = messages.length;
    }

    // Derive tools_used from messages if not explicitly provided
    if (toolsUsed === undefined) {
      const toolSet = new Set<string>();
      for (const msg of messages) {
        if (msg.tool_name !== undefined) {
          toolSet.add(msg.tool_name);
        }
      }
      if (toolSet.size > 0) {
        toolsUsed = Array.from(toolSet);
      }
    }

    // Derive duration from message timestamps if not explicitly provided
    if (durationMinutes === undefined && messages.length >= 2) {
      const timestamps = messages
        .map((m) => new Date(m.timestamp).getTime())
        .filter((t) => !Number.isNaN(t))
        .sort((a, b) => a - b);

      if (timestamps.length >= 2) {
        const firstTs = timestamps[0];
        const lastTs = timestamps[timestamps.length - 1];
        durationMinutes = Math.round((lastTs - firstTs) / 60000);
      }
    }
  }

  // Build insert payload
  const insertPayload: Record<string, unknown> = {
    session_key: body.session_key,
    source: body.source,
  };

  if (projectId !== null) {
    insertPayload.project_id = projectId;
  }
  if (messageCount !== undefined) {
    insertPayload.message_count = messageCount;
  }
  if (durationMinutes !== undefined) {
    insertPayload.duration_minutes = durationMinutes;
  }
  if (filesTouched !== undefined) {
    insertPayload.files_touched = filesTouched;
  }
  if (toolsUsed !== undefined) {
    insertPayload.tools_used = toolsUsed;
  }
  // Build metadata with raw_content for the analyzer
  const sessionMetadata: Record<string, unknown> = {};
  if (body.metadata !== undefined) {
    for (const [k, v] of Object.entries(body.metadata)) {
      sessionMetadata[k] = v;
    }
  }

  // Build raw_content from messages so the analyzer has content to work with
  if (messages !== undefined && messages.length > 0) {
    const rawParts: string[] = [];
    let rawLen = 0;
    const maxRawLen = 50000;
    for (const msg of messages) {
      if (rawLen >= maxRawLen) break;
      const line = `[${msg.role}] ${msg.content}`;
      rawParts.push(line);
      rawLen += line.length;
    }
    sessionMetadata.raw_content = rawParts.join('\n').slice(0, maxRawLen);
  }

  if (Object.keys(sessionMetadata).length > 0) {
    insertPayload.metadata = sessionMetadata;
  }
  if (body.session_started_at !== undefined) {
    insertPayload.session_started_at = body.session_started_at;
  }
  if (body.session_ended_at !== undefined) {
    insertPayload.session_ended_at = body.session_ended_at;
  }

  // Redact secrets from metadata before storage
  if (insertPayload.metadata !== undefined) {
    const metaStr = JSON.stringify(insertPayload.metadata);
    const { redacted, redactionCount } = redactSecrets(metaStr);
    if (redactionCount > 0) {
      insertPayload.metadata = JSON.parse(redacted) as Record<string, unknown>;
      logger.info({ sessionKey: body.session_key, redactionCount }, '[Watchtower/SessionWebhook] Redacted secrets from metadata');
    }
  }

  // Insert into coding_sessions
  const { data: insertedRow, error: insertError } = await queryWatchtower('coding_sessions')
    .insert(insertPayload)
    .select('id')
    .single();

  if (insertError !== null) {
    logger.error(
      { error: insertError.message, sessionKey: body.session_key },
      '[Watchtower/SessionWebhook] Failed to insert session',
    );
    return c.json({ error: 'Failed to store session', detail: insertError.message }, 500);
  }

  const insertedData = insertedRow as InsertedSessionRow | null;
  if (insertedData === null) {
    return c.json({ error: 'Insert returned no data' }, 500);
  }

  // Emit event for downstream processing
  await inngest.send({
    name: 'watchtower/coding-session.received',
    data: {
      session_id: insertedData.id,
      project_id: projectId,
      project_slug: projectSlug,
    },
  });

  logger.info(
    { sessionId: insertedData.id, projectSlug, source: body.source },
    '[Watchtower/SessionWebhook] Session ingested successfully',
  );

  return c.json({
    status: 'ok',
    session_id: insertedData.id,
  });
}
