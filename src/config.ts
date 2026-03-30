/**
 * Watchtower Configuration
 */

export const CRON_SCHEDULES = {
  session_scanner: '0 */4 * * *',
  commit_analyzer: '*/30 * * * *',
  doc_indexer: '0 */12 * * *',
} as const;

export const DOC_INDEXER_CONFIG = {
  file_patterns: ['**/*.md', '**/README*', '**/CLAUDE.md', '**/docs/**'],
  exclude_patterns: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
  max_file_size_bytes: 512_000,
  chunk_size_tokens: 800,
  chunk_overlap_tokens: 200,
  embedding_model: 'voyage-4-large' as const,
  embedding_dimensions: 1024,
} as const;
