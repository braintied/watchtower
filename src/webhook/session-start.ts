/**
 * Session Start Webhook — Track Active Claude Code Sessions
 *
 * Receives session start events from the Claude Code SessionStart hook.
 * Records the session as "active" in coding_sessions so Watchtower can
 * provide real-time awareness of what's being worked on.
 *
 * POST /webhooks/session-start
 */

import { z } from 'zod';
import type { Context } from 'hono';
import { queryWatchtower } from '../lib/db.js';
import { logger } from '../lib/logger.js';

// =============================================================================
// SCHEMA
// =============================================================================

const SessionStartSchema = z.object({
  session_key: z.string(),
  project_slug: z.string().optional(),
  directory: z.string().optional(),
  started_at: z.string(),
});

// =============================================================================
// HANDLER
// =============================================================================

export async function handleSessionStartWebhook(c: Context): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: 'Failed to read request body' }, 400);
  }

  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const parseResult = SessionStartSchema.safeParse(jsonBody);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed' }, 400);
  }

  const body = parseResult.data;

  logger.info(
    { sessionKey: body.session_key, projectSlug: body.project_slug },
    '[Watchtower/SessionStart] Session started',
  );

  // Upsert a minimal session row marking it as "active"
  // If the Stop hook already created this session, don't overwrite
  const { error: upsertError } = await queryWatchtower('coding_sessions')
    .upsert(
      {
        session_key: body.session_key,
        source: 'claude_code',
        session_started_at: body.started_at,
        metadata: {
          status: 'active',
          directory: body.directory,
          project_slug: body.project_slug,
        },
      },
      { onConflict: 'session_key', ignoreDuplicates: true },
    );

  if (upsertError !== null) {
    if (!upsertError.message.includes('duplicate') && !upsertError.message.includes('unique')) {
      logger.warn(
        { error: upsertError.message, sessionKey: body.session_key },
        '[Watchtower/SessionStart] Failed to record session start',
      );
    }
  }

  return c.json({ status: 'ok', session_key: body.session_key });
}
