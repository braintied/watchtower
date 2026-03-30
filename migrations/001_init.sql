-- Watchtower — Initial Schema
-- Creates the watchtower schema with session intelligence tables.
-- Requires: pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS watchtower;

-- =============================================================================
-- TABLES
-- =============================================================================

CREATE TABLE watchtower.coding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'claude_code',
  title TEXT,
  ai_summary TEXT,
  category TEXT,
  files_touched TEXT[] DEFAULT '{}',
  tools_used TEXT[] DEFAULT '{}',
  decisions JSONB DEFAULT '[]',
  duration_minutes INT,
  message_count INT DEFAULT 0,
  embedding vector(1024),
  embedding_half halfvec(1024),
  metadata JSONB DEFAULT '{}',
  session_started_at TIMESTAMPTZ,
  session_ended_at TIMESTAMPTZ,
  analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE watchtower.session_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES watchtower.coding_sessions(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1024),
  embedding_half halfvec(1024),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, chunk_index)
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_coding_sessions_source ON watchtower.coding_sessions(source);
CREATE INDEX idx_coding_sessions_category ON watchtower.coding_sessions(category);
CREATE INDEX idx_coding_sessions_started ON watchtower.coding_sessions(session_started_at DESC);

-- Vector HNSW indexes (halfvec for 50% storage reduction)
CREATE INDEX idx_coding_sessions_embedding_half ON watchtower.coding_sessions
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_session_chunks_session ON watchtower.session_chunks(session_id);
CREATE INDEX idx_session_chunks_hash ON watchtower.session_chunks(content_hash);
CREATE INDEX idx_session_chunks_embedding_half ON watchtower.session_chunks
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- AUTO-SYNC HALFVEC TRIGGER
-- =============================================================================

CREATE OR REPLACE FUNCTION watchtower.sync_embedding_half()
RETURNS trigger AS $$
BEGIN
  IF NEW.embedding IS NOT NULL THEN
    NEW.embedding_half := NEW.embedding::halfvec(1024);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_coding_sessions_embedding_half
  BEFORE INSERT OR UPDATE OF embedding ON watchtower.coding_sessions
  FOR EACH ROW EXECUTE FUNCTION watchtower.sync_embedding_half();

CREATE TRIGGER trg_session_chunks_embedding_half
  BEFORE INSERT OR UPDATE OF embedding ON watchtower.session_chunks
  FOR EACH ROW EXECUTE FUNCTION watchtower.sync_embedding_half();

-- =============================================================================
-- SEARCH RPCS
-- =============================================================================

-- Semantic search across session chunks
CREATE OR REPLACE FUNCTION watchtower.search_sessions(
  p_query_embedding vector(1024),
  p_match_count INT DEFAULT 10,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  session_id UUID,
  chunk_id UUID,
  session_key TEXT,
  title TEXT,
  ai_summary TEXT,
  category TEXT,
  chunk_content TEXT,
  chunk_index INT,
  similarity FLOAT,
  session_started_at TIMESTAMPTZ
)
LANGUAGE sql STABLE
SET search_path = watchtower, public, extensions
AS $$
  SELECT
    s.id AS session_id,
    sc.id AS chunk_id,
    s.session_key,
    s.title,
    s.ai_summary,
    s.category,
    sc.content AS chunk_content,
    sc.chunk_index,
    1 - (sc.embedding <=> p_query_embedding) AS similarity,
    s.session_started_at
  FROM watchtower.session_chunks sc
  JOIN watchtower.coding_sessions s ON s.id = sc.session_id
  WHERE sc.embedding IS NOT NULL
    AND 1 - (sc.embedding <=> p_query_embedding) >= p_similarity_threshold
  ORDER BY sc.embedding <=> p_query_embedding
  LIMIT p_match_count;
$$;

-- Session activity summary
CREATE OR REPLACE FUNCTION watchtower.get_session_activity(
  p_days INT DEFAULT 7
)
RETURNS TABLE (
  total_sessions BIGINT,
  total_messages BIGINT,
  categories JSONB,
  files_touched_count BIGINT,
  decisions_count BIGINT,
  avg_duration_minutes INT
)
LANGUAGE sql STABLE
SET search_path = watchtower, public, extensions
AS $$
  WITH filtered AS (
    SELECT *
    FROM watchtower.coding_sessions
    WHERE session_started_at >= now() - (p_days || ' days')::interval
  ),
  category_agg AS (
    SELECT COALESCE(jsonb_object_agg(category, cnt), '{}'::jsonb) AS categories
    FROM (
      SELECT category, COUNT(*) AS cnt
      FROM filtered
      WHERE category IS NOT NULL
      GROUP BY category
    ) sub
  ),
  files_agg AS (
    SELECT COUNT(DISTINCT f)::BIGINT AS files_touched_count
    FROM filtered, unnest(files_touched) AS f
  )
  SELECT
    COUNT(*)::BIGINT AS total_sessions,
    COALESCE(SUM(message_count), 0)::BIGINT AS total_messages,
    (SELECT categories FROM category_agg) AS categories,
    (SELECT files_touched_count FROM files_agg) AS files_touched_count,
    COALESCE(SUM(jsonb_array_length(decisions)), 0)::BIGINT AS decisions_count,
    COALESCE(AVG(duration_minutes)::INT, 0) AS avg_duration_minutes
  FROM filtered;
$$;
