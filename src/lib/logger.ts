/**
 * Simple structured logger for Watchtower.
 */

function formatMeta(meta: Record<string, unknown>): string {
  const entries = Object.entries(meta);
  if (entries.length === 0) return '';
  return ' ' + entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}

export const logger = {
  info(meta: Record<string, unknown>, msg: string): void {
    console.log(`[INFO] ${msg}${formatMeta(meta)}`);
  },
  warn(meta: Record<string, unknown>, msg: string): void {
    console.warn(`[WARN] ${msg}${formatMeta(meta)}`);
  },
  error(meta: Record<string, unknown>, msg: string): void {
    console.error(`[ERROR] ${msg}${formatMeta(meta)}`);
  },
  debug(meta: Record<string, unknown>, msg: string): void {
    if (process.env.DEBUG === '1') {
      console.log(`[DEBUG] ${msg}${formatMeta(meta)}`);
    }
  },
};
