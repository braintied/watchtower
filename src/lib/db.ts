/**
 * Database client for Watchtower.
 * Uses Supabase JS client with the watchtower schema.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (SUPABASE_URL === undefined || SUPABASE_URL === '') {
  throw new Error('SUPABASE_URL is required');
}
if (SUPABASE_KEY === undefined || SUPABASE_KEY === '') {
  throw new Error('SUPABASE_SERVICE_KEY is required');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'watchtower' },
});

/**
 * Query helper that targets the watchtower schema.
 */
export function queryWatchtower(table: string) {
  return supabase.from(table);
}

export { supabase };
