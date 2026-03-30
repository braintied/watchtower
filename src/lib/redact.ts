/**
 * Secret Redaction for Session Intelligence
 *
 * Strips API keys, tokens, passwords, and credentials from text content
 * before storing in the database. Prevents accidental secret leakage
 * into watchtower.coding_sessions and watchtower.session_chunks.
 */

// =============================================================================
// REDACTION PATTERNS
// =============================================================================

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Patterns ordered from most-specific to most-generic to avoid
 * over-matching. Each regex uses the global flag for multi-match.
 */
const REDACTION_RULES: RedactionRule[] = [
  // ── Anthropic ──
  { pattern: /\bsk-ant-[a-zA-Z0-9\-]{20,}\b/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },

  // ── OpenAI ──
  { pattern: /\bsk-proj-[a-zA-Z0-9\-]{20,}\b/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, replacement: '[REDACTED_SK_KEY]' },

  // ── Supabase ──
  { pattern: /\bsbp_[a-zA-Z0-9]{20,}\b/g, replacement: '[REDACTED_SUPABASE_TOKEN]' },

  // ── GitHub ──
  { pattern: /\bgithub_pat_[a-zA-Z0-9_]{80,}\b/g, replacement: '[REDACTED_GITHUB_PAT]' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, replacement: '[REDACTED_GITHUB_OAUTH]' },

  // ── Fly.io ──
  { pattern: /\bfo1_[a-zA-Z0-9_\-]{30,}\b/g, replacement: '[REDACTED_FLY_TOKEN]' },

  // ── Stripe ──
  { pattern: /\bsk_live_[a-zA-Z0-9]{20,}\b/g, replacement: '[REDACTED_STRIPE_LIVE]' },
  { pattern: /\bsk_test_[a-zA-Z0-9]{20,}\b/g, replacement: '[REDACTED_STRIPE_TEST]' },
  { pattern: /\brk_live_[a-zA-Z0-9]{20,}\b/g, replacement: '[REDACTED_STRIPE_RESTRICTED]' },

  // ── Voyage AI ──
  { pattern: /\bpa-[a-zA-Z0-9_\-]{20,}\b/g, replacement: '[REDACTED_VOYAGE_KEY]' },

  // ── AWS ──
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },

  // ── JWTs (long base64 tokens starting with eyJ) ──
  { pattern: /\beyJ[a-zA-Z0-9_\-]{100,}\b/g, replacement: '[REDACTED_JWT]' },

  // ── Sentry DSN ──
  { pattern: /https:\/\/[a-f0-9]{32}@[a-z0-9]+\.ingest\.sentry\.io\/[0-9]+/g, replacement: '[REDACTED_SENTRY_DSN]' },

  // ── Bearer tokens in headers ──
  { pattern: /(Bearer\s+)([a-zA-Z0-9_\-\.]{20,})/g, replacement: '$1[REDACTED_BEARER]' },

  // ── Generic env-style secrets (KEY=value, SECRET=value, etc.) ──
  { pattern: /^([A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY))=(.{8,})$/gm, replacement: '$1=[REDACTED]' },

  // ── Inline key=value patterns ──
  { pattern: /(api[_-]?key|secret|token|password|auth[_-]?token)[=:]\s*["']?([a-zA-Z0-9_\-]{20,})["']?/gi, replacement: '$1=[REDACTED]' },

  // ── Long hex strings (64+ chars — likely encryption keys) ──
  { pattern: /\b[a-f0-9]{64,}\b/g, replacement: '[REDACTED_HEX_SECRET]' },
];

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Redact secrets from text content.
 * Returns the redacted text and a count of redactions made.
 */
export function redactSecrets(text: string): { redacted: string; redactionCount: number } {
  let redacted = text;
  let redactionCount = 0;

  for (const rule of REDACTION_RULES) {
    // Clone the regex to reset lastIndex state
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = redacted.match(regex);
    if (matches !== null && matches.length > 0) {
      redactionCount += matches.length;
      redacted = redacted.replace(regex, rule.replacement);
    }
  }

  return { redacted, redactionCount };
}

/**
 * Redact secrets from an array of strings.
 */
export function redactSecretsFromArray(items: string[]): { redacted: string[]; totalRedactions: number } {
  let totalRedactions = 0;
  const redacted: string[] = [];

  for (const item of items) {
    const result = redactSecrets(item);
    redacted.push(result.redacted);
    totalRedactions += result.redactionCount;
  }

  return { redacted, totalRedactions };
}
