/**
 * Watchtower — AI Coding Session Intelligence
 *
 * Open-source server that auto-captures Claude Code sessions,
 * AI-analyzes them, and makes them searchable.
 *
 * https://github.com/braintied/watchtower
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serve as inngestServe } from 'inngest/hono';
import { inngest } from './inngest/client.js';
import { createSessionScanner } from './inngest/session-scanner.js';
import { createSessionAnalyzer } from './inngest/session-analyzer.js';
import { handleSessionWebhook } from './webhook/session.js';
import { handleSessionStartWebhook } from './webhook/session-start.js';
import { logger } from './lib/logger.js';

const app = new Hono();

// All Inngest functions
const allFunctions = [
  createSessionScanner(inngest),
  createSessionAnalyzer(inngest),
];

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'watchtower' });
});

// Inngest sync endpoint
app.on(['GET', 'POST', 'PUT'], '/api/inngest', inngestServe({ client: inngest, functions: allFunctions }));

// Session webhooks
app.post('/webhooks/session', handleSessionWebhook);
app.post('/webhooks/session-start', handleSessionStartWebhook);

const port = parseInt(process.env.PORT !== undefined && process.env.PORT !== '' ? process.env.PORT : '5003', 10);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'Watchtower listening');
});
