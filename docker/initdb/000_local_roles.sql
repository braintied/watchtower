-- Local compose only. Runs before migrations/001_init.sql on first boot.
--
-- PostgREST connects as `postgres`, then switches to the role named in
-- the request JWT: `anon` with no token, the local service role with
-- the stub key in docker-compose.yml. Neither role exists in a plain
-- Postgres image, and 001_init.sql grants nothing, so without this file
-- every insert from the server fails (measured 2026-10-15 on a fresh
-- clone: PostgREST exited, /webhooks/session returned "fetch failed").
--
-- Your own Postgres or a Supabase project already has its own roles.
-- Do not apply this file there.

CREATE ROLE anon NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;  -- git-secret-allow: role name for the local PostgREST stub, no credential

CREATE SCHEMA IF NOT EXISTS watchtower;
GRANT USAGE ON SCHEMA public, watchtower TO anon, service_role;  -- git-secret-allow: local stub role grant, no credential

ALTER DEFAULT PRIVILEGES IN SCHEMA watchtower
  GRANT ALL ON TABLES TO service_role;  -- git-secret-allow: local stub role grant, no credential
ALTER DEFAULT PRIVILEGES IN SCHEMA watchtower
  GRANT ALL ON SEQUENCES TO service_role;  -- git-secret-allow: local stub role grant, no credential
ALTER DEFAULT PRIVILEGES IN SCHEMA watchtower
  GRANT EXECUTE ON FUNCTIONS TO service_role;  -- git-secret-allow: local stub role grant, no credential
