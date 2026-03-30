/**
 * Watchtower: Session Analyzer
 *
 * Triggered by: watchtower/coding-session.received
 *
 * For each coding session:
 * 1. Fetch session from DB, extract raw content
 * 2. Chunk content into ~500-token segments with overlap
 * 3. AI-analyze: title, summary, category, decisions (Haiku)
 * 4. Generate session-level embedding for semantic search
 * 5. Update session row with analysis results
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Inngest } from 'inngest';
import { queryWatchtower } from '../lib/db.js';
import { analyzeWithHaiku } from '../lib/ai.js';
import { embedText } from '../lib/embedding.js';
import { logger } from '../lib/logger.js';
import { redactSecrets } from '../lib/redact.js';

// =============================================================================
// TYPES
// =============================================================================

interface SessionRow {
  id: string;
  project_id: string | null;
  session_key: string;
  title: string | null;
  ai_summary: string | null;
  category: string | null;
  files_touched: string[] | null;
  tools_used: string[] | null;
  session_started_at: string | null;
  session_ended_at: string | null;
  metadata: SessionMetadata | null;
}

interface SessionMetadata {
  raw_content?: string;
  session_dir?: string;
  message_count?: number;
  [key: string]: unknown;
}

interface SessionDecision {
  decision: string;
  reasoning: string;
  context: string;
}

interface ChunkRecord {
  session_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  embedding: string;
}

// Zod schemas for structured AI output validation
const CategorySchema = z.enum(['feature', 'bugfix', 'refactor', 'debug', 'docs', 'config', 'exploration']);
type SessionCategory = z.infer<typeof CategorySchema>;

const DecisionSchema = z.object({
  decision: z.string(),
  reasoning: z.string(),
  context: z.string(),
});
const DecisionsArraySchema = z.array(DecisionSchema).max(5);

// Chunking constants: ~500 tokens per chunk, 10% overlap
const CHARS_PER_CHUNK = 2000;
const CHARS_OVERLAP = 200;

// =============================================================================
// CHUNKING
// =============================================================================

function chunkContent(content: string): string[] {
  const chunks: string[] = [];

  if (content.length <= CHARS_PER_CHUNK) {
    chunks.push(content);
    return chunks;
  }

  let offset = 0;
  while (offset < content.length) {
    const end = Math.min(offset + CHARS_PER_CHUNK, content.length);
    chunks.push(content.slice(offset, end));

    if (end >= content.length) {
      break;
    }

    offset = end - CHARS_OVERLAP;
  }

  return chunks;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// =============================================================================
// STRUCTURED OUTPUT PARSING (Zod-validated)
// =============================================================================

/**
 * Strip markdown code fences from LLM output.
 */
function stripCodeFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('```'));
    }
  }
  return cleaned.trim();
}

/**
 * Parse and validate decisions from LLM output using Zod.
 * Returns validated decisions array, or [] on any failure.
 */
function parseDecisions(raw: string): SessionDecision[] {
  try {
    const cleaned = stripCodeFences(raw);
    const parsed: unknown = JSON.parse(cleaned);
    const result = DecisionsArraySchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Parse and validate category from LLM output using Zod.
 * Returns validated category or 'exploration' as default.
 */
function parseCategory(raw: string): SessionCategory {
  const trimmed = raw.trim().toLowerCase();
  const result = CategorySchema.safeParse(trimmed);
  if (result.success) {
    return result.data;
  }
  return 'exploration';
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

export function createSessionAnalyzer(client: Inngest) {
  return client.createFunction(
    {
      id: 'watchtower/session-analyzer',
      name: 'Watchtower: Session Analyzer',
      concurrency: [{ limit: 2 }],
      retries: 2,
    },
    { event: 'watchtower/coding-session.received' },
    async ({ event, step }) => {
      const { session_id } = event.data;

      // Step 1: Fetch session from DB
      const session = await step.run('fetch-session', async () => {
        const { data, error } = await queryWatchtower('coding_sessions')
          .select('id, project_id, session_key, title, ai_summary, category, files_touched, tools_used, session_started_at, session_ended_at, metadata')
          .eq('id', session_id)
          .single();

        if (error !== null) {
          throw new Error(`Failed to fetch session: ${error.message}`);
        }

        if (data === null) {
          throw new Error(`Session not found: ${session_id}`);
        }

        return data as SessionRow;
      });

      // Extract raw content from metadata or construct from available fields
      const metadata = session.metadata;
      let rawContent = '';

      if (metadata !== null && metadata !== undefined && typeof metadata.raw_content === 'string' && metadata.raw_content.length > 0) {
        rawContent = metadata.raw_content;
      } else {
        // Construct from available fields
        const parts: string[] = [];
        if (session.session_key !== null && session.session_key !== undefined) {
          parts.push(`Session: ${session.session_key}`);
        }
        if (session.files_touched !== null && session.files_touched !== undefined && session.files_touched.length > 0) {
          parts.push(`Files touched:\n${session.files_touched.join('\n')}`);
        }
        if (session.tools_used !== null && session.tools_used !== undefined && session.tools_used.length > 0) {
          parts.push(`Tools used:\n${session.tools_used.join('\n')}`);
        }
        if (session.title !== null && session.title !== undefined) {
          parts.push(`Title: ${session.title}`);
        }
        if (session.ai_summary !== null && session.ai_summary !== undefined) {
          parts.push(`Summary: ${session.ai_summary}`);
        }
        rawContent = parts.join('\n\n');
      }

      if (rawContent.length === 0) {
        logger.warn({ session_id }, '[Watchtower/SessionAnalyzer] No content available for session');
        return { status: 'skip', reason: 'no content available', session_id };
      }

      // Redact secrets before chunking and AI analysis
      const { redacted: cleanContent, redactionCount } = redactSecrets(rawContent);
      if (redactionCount > 0) {
        logger.info({ session_id, redactionCount }, '[Watchtower/SessionAnalyzer] Redacted secrets from session content');
      }
      rawContent = cleanContent;

      logger.info(
        { session_id, content_length: rawContent.length },
        '[Watchtower/SessionAnalyzer] Analyzing session',
      );

      // Step 2: Chunk content and embed
      const chunksCreated = await step.run('chunk-content', async () => {
        const textChunks = chunkContent(rawContent);
        let insertedCount = 0;

        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i];
          if (chunk === undefined) {
            continue;
          }

          const contentHash = hashContent(chunk);

          let embedding: number[];
          try {
            embedding = await embedText(chunk, 'document');
          } catch (embErr) {
            const errMsg = embErr instanceof Error ? embErr.message : 'Unknown error';
            logger.warn({ session_id, chunk_index: i, error: errMsg }, '[Watchtower/SessionAnalyzer] Failed to embed chunk, skipping');
            continue;
          }

          const record: ChunkRecord = {
            session_id: session.id,
            chunk_index: i,
            content: chunk,
            content_hash: contentHash,
            embedding: JSON.stringify(embedding),
          };

          const { error: insertError } = await queryWatchtower('session_chunks').insert(record);

          if (insertError !== null) {
            logger.error(
              { session_id, chunk_index: i, error: insertError.message },
              '[Watchtower/SessionAnalyzer] Failed to insert chunk',
            );
          } else {
            insertedCount++;
          }
        }

        return insertedCount;
      });

      // Step 3: AI analysis
      const filesStr = session.files_touched !== null && session.files_touched !== undefined
        ? session.files_touched.slice(0, 30).join('\n')
        : '';
      const toolsStr = session.tools_used !== null && session.tools_used !== undefined
        ? session.tools_used.join(', ')
        : '';

      const aiResults = await step.run('ai-analyze', async () => {
        // 3a. Title generation
        let title = session.session_key;
        try {
          const titleInput = [
            rawContent.slice(0, 3000),
            filesStr.length > 0 ? `\nFiles touched:\n${filesStr}` : '',
            toolsStr.length > 0 ? `\nTools used: ${toolsStr}` : '',
          ].join('');

          const rawTitle = await analyzeWithHaiku(
            'Generate a concise title (5-10 words) for this coding session. Focus on the primary task accomplished. Reply with ONLY the title, no quotes or punctuation wrapping.',
            titleInput,
          );
          title = rawTitle.trim();
        } catch (titleErr) {
          const errMsg = titleErr instanceof Error ? titleErr.message : 'Unknown error';
          logger.warn({ session_id, error: errMsg }, '[Watchtower/SessionAnalyzer] Title generation failed, using session_key');
        }

        // 3b. Summary generation
        let summary = '';
        try {
          const rawSummary = await analyzeWithHaiku(
            'Summarize this coding session in 2-3 sentences. Be specific about what was built, fixed, or explored. Mention key files and architectural decisions.',
            rawContent.slice(0, 5000),
          );
          summary = rawSummary.trim();
        } catch (summaryErr) {
          const errMsg = summaryErr instanceof Error ? summaryErr.message : 'Unknown error';
          logger.warn({ session_id, error: errMsg }, '[Watchtower/SessionAnalyzer] Summary generation failed');
        }

        // 3c. Category classification (Zod-validated)
        let category: SessionCategory = 'exploration';
        try {
          const categoryInput = `Title: ${title}\nSummary: ${summary}\nFiles: ${filesStr}`;
          const rawCategory = await analyzeWithHaiku(
            'Reply with ONLY the category word: feature, bugfix, refactor, debug, docs, config, or exploration.',
            categoryInput,
          );
          category = parseCategory(rawCategory);
        } catch (catErr) {
          const errMsg = catErr instanceof Error ? catErr.message : 'Unknown error';
          logger.warn({ session_id, error: errMsg }, '[Watchtower/SessionAnalyzer] Category classification failed, defaulting to exploration');
        }

        // 3d. Decision extraction (Zod-validated with retry)
        let decisions: SessionDecision[] = [];
        try {
          const decisionPrompt = 'Extract key technical decisions from this coding session. Return ONLY a valid JSON array of objects with "decision", "reasoning", and "context" string fields. Return [] if no significant decisions. Maximum 5 decisions. No markdown, no explanation — just the JSON array.';
          const rawDecisions = await analyzeWithHaiku(decisionPrompt, rawContent.slice(0, 8000));
          decisions = parseDecisions(rawDecisions);

          // Retry once if parsing returned empty but content exists
          if (decisions.length === 0 && rawContent.length > 500) {
            const retryRaw = await analyzeWithHaiku(
              'Your previous response was not valid JSON. Respond with ONLY a JSON array like: [{"decision":"...","reasoning":"...","context":"..."}]. No markdown fences. Return [] if no decisions.',
              rawContent.slice(0, 8000),
            );
            decisions = parseDecisions(retryRaw);
          }
        } catch (decErr) {
          const errMsg = decErr instanceof Error ? decErr.message : 'Unknown error';
          logger.warn({ session_id, error: errMsg }, '[Watchtower/SessionAnalyzer] Decision extraction failed');
        }

        return { title, summary, category, decisions };
      });

      // Step 4: Generate session-level embedding
      const sessionEmbedding = await step.run('generate-summary-embedding', async () => {
        const embedInput = `${aiResults.title}\n${aiResults.summary}`;
        try {
          return await embedText(embedInput, 'document');
        } catch (embErr) {
          const errMsg = embErr instanceof Error ? embErr.message : 'Unknown error';
          logger.warn({ session_id, error: errMsg }, '[Watchtower/SessionAnalyzer] Session embedding failed');
          return null;
        }
      });

      // Step 5: Update session row
      await step.run('update-session', async () => {
        const update: Record<string, unknown> = {
          title: aiResults.title,
          ai_summary: aiResults.summary,
          category: aiResults.category,
          decisions: aiResults.decisions,
          analyzed_at: new Date().toISOString(),
        };

        if (sessionEmbedding !== null) {
          update.embedding = JSON.stringify(sessionEmbedding);
        }

        const { error } = await queryWatchtower('coding_sessions')
          .update(update)
          .eq('id', session.id);

        if (error !== null) {
          logger.error(
            { session_id, error: error.message },
            '[Watchtower/SessionAnalyzer] Failed to update session',
          );
          throw new Error(`Failed to update session: ${error.message}`);
        }

        logger.info(
          { session_id, title: aiResults.title, category: aiResults.category },
          '[Watchtower/SessionAnalyzer] Session updated',
        );
      });

      return {
        status: 'complete',
        session_id,
        title: aiResults.title,
        category: aiResults.category,
        chunks_created: chunksCreated,
        decisions_count: aiResults.decisions.length,
      };
    },
  );
}
