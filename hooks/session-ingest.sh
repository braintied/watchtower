#!/bin/bash
# OSS Stop hook — webhook only. Synced from @braintied/watchtower 5.3.1.
# Fleet hooks that PATCH Cortex with a privileged REST key are not in this tree.
#
# Env: WATCHTOWER_SESSION_WEBHOOK_URL (default http://localhost:5003/webhooks/session)

INPUT=$(cat)

SESSION_ID=""
DIRECTORY=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.sessionId // .session_id // ""' 2>/dev/null)
  DIRECTORY=$(printf '%s' "$INPUT" | jq -r '.directory // .cwd // ""' 2>/dev/null)
fi
[ -n "$DIRECTORY" ] || DIRECTORY=$(pwd)
if [ -z "$SESSION_ID" ]; then
  echo '{"continue": true}'
  exit 0
fi

HOOK_LIB="$(cd "$(dirname "$0")" && pwd)/lib"
# shellcheck source=lib/session-key.sh
. "$HOOK_LIB/session-key.sh"
# shellcheck source=lib/refuse-hosted.sh
. "$HOOK_LIB/refuse-hosted.sh"
watchtower_resolve_session_key || true

WEBHOOK_URL="${WATCHTOWER_SESSION_WEBHOOK_URL:-http://localhost:5003/webhooks/session}"
if watchtower_is_braintied_production "$WEBHOOK_URL"; then
  echo "watchtower: refusing to POST to Braintied production ($WEBHOOK_URL)." >&2
  echo "watchtower: this client is code you run. Point WATCHTOWER_SESSION_WEBHOOK_URL at a host you control." >&2
  echo '{"continue": true}'
  exit 0
fi
PROJECT_SLUG=$(basename "$DIRECTORY")
if [ -x "$HOOK_LIB/project-slug.sh" ]; then
  RESOLVED=$("$HOOK_LIB/project-slug.sh" "$DIRECTORY" 2>/dev/null || true)
  [ -n "$RESOLVED" ] && PROJECT_SLUG="$RESOLVED"
fi

SOURCE="${WATCHTOWER_SOURCE_COLUMN:-claude_code}"
KEY="${SESSION_KEY:-claude:${SESSION_ID}}"

CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
ENCODED_DIR=$(printf '%s' "$DIRECTORY" | sed 's|/|-|g')
SESSION_DIR=""
if [ -d "$CLAUDE_PROJECTS_DIR/$ENCODED_DIR/$SESSION_ID" ]; then
  SESSION_DIR="$CLAUDE_PROJECTS_DIR/$ENCODED_DIR/$SESSION_ID"
fi

RAW_CONTENT=""
MESSAGE_COUNT=0
if [ -n "$SESSION_DIR" ] && [ -d "$SESSION_DIR/subagents" ] && command -v jq >/dev/null 2>&1; then
  EXTRACTED=$(cat "$SESSION_DIR/subagents"/*.jsonl 2>/dev/null | jq -s '{
    message_count: length,
    raw_content: ([.[] | (
      if .type == "user" then "[user] " + ((.message.content // "") | tostring)
      elif .type == "assistant" then "[assistant] " + (([.message.content[]? | select(.type=="text") | .text] | join("\n")))
      else empty end
    )] | join("\n") | .[0:50000])
  }' 2>/dev/null)
  if [ -n "$EXTRACTED" ]; then
    MESSAGE_COUNT=$(printf '%s' "$EXTRACTED" | jq -r '.message_count // 0')
    RAW_CONTENT=$(printf '%s' "$EXTRACTED" | jq -r '.raw_content // ""')
  fi
fi

PAYLOAD=$(jq -n \
  --arg session_key "$KEY" \
  --arg source "$SOURCE" \
  --arg project_slug "$PROJECT_SLUG" \
  --argjson message_count "${MESSAGE_COUNT:-0}" \
  --arg raw_content "$RAW_CONTENT" \
  '{
    session_key: $session_key,
    source: $source,
    project_slug: $project_slug,
    message_count: $message_count,
    metadata: { raw_content: (if $raw_content == "" then null else $raw_content end), source_hook: "oss-session-ingest" }
  }' 2>/dev/null)

if [ -n "$PAYLOAD" ]; then
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 5 --max-time 30 >/dev/null 2>&1 &
fi

echo '{"continue": true}'
exit 0
