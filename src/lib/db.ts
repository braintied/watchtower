/**
 * Database client for Watchtower.
 *
 * Talks to PostgREST, scoped to the `watchtower` schema.
 *
 * SUPABASE_URL is a project root: the REST API lives at
 * `${SUPABASE_URL}/rest/v1`, which is where @supabase/supabase-js and
 * every hosted Supabase project put it. A bare PostgREST (the `rest`
 * container in docker-compose.yml, or your own) serves at `/`, so it
 * is named with WATCHTOWER_REST_URL instead. Measured 2026-10-15 on a
 * fresh clone: with only SUPABASE_URL=http://rest:3000 every insert
 * went to /rest/v1/coding_sessions, PostgREST answered 404, and no
 * session was ever stored.
 */

import { PostgrestClient } from '@supabase/postgrest-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST_URL = process.env.WATCHTOWER_REST_URL;

if ((REST_URL === undefined || REST_URL === '') && (SUPABASE_URL === undefined || SUPABASE_URL === '')) {
  throw new Error('SUPABASE_URL (a Supabase project) or WATCHTOWER_REST_URL (a bare PostgREST) is required');
}
if (SUPABASE_KEY === undefined || SUPABASE_KEY === '') {
  throw new Error('SUPABASE_SERVICE_KEY is required');
}

export function restUrl(env: { rest?: string; supabase?: string }): string {
  if (env.rest !== undefined && env.rest !== '') return env.rest.replace(/\/+$/, '');
  if (env.supabase !== undefined && env.supabase !== '') {
    return `${env.supabase.replace(/\/+$/, '')}/rest/v1`;
  }
  throw new Error('no REST URL');
}

const client = new PostgrestClient(restUrl({ rest: REST_URL, supabase: SUPABASE_URL }), {
  schema: 'watchtower',
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  },
});

/**
 * Query helper that targets the watchtower schema.
 */
export function queryWatchtower(table: string) {
  return client.from(table);
}
