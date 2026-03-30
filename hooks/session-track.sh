#!/bin/bash
# Session Track Hook — Register session start with Watchtower
#
# Fires on Claude Code SessionStart event. Records the session start time
# and project so Watchtower can track active sessions in real-time.
#
# Env: WATCHTOWER_SESSION_WEBHOOK_URL (defaults to local dev server)

INPUT=$(cat)

# Extract session info
SESSION_ID=""
DIRECTORY=""
if command -v jq &> /dev/null; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.sessionId // .session_id // ""' 2>/dev/null)
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
fi

if [ -z "$DIRECTORY" ]; then
  DIRECTORY=$(pwd)
fi

# If no session ID, can't track — pass through to existing session-start.sh
if [ -z "$SESSION_ID" ]; then
  echo '{"continue": true}'
  exit 0
fi

WEBHOOK_URL="${WATCHTOWER_SESSION_START_URL:-http://localhost:5003/webhooks/session-start}"
PROJECT_DIR=$(basename "$DIRECTORY")
ENCODED_DIR=$(echo "$DIRECTORY" | sed 's|/|-|g')
SESSION_KEY="$ENCODED_DIR/$SESSION_ID"
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build and send payload (fire-and-forget)
if command -v jq &> /dev/null; then
  PAYLOAD=$(jq -n \
    --arg session_key "$SESSION_KEY" \
    --arg project_slug "$PROJECT_DIR" \
    --arg directory "$DIRECTORY" \
    --arg started_at "$STARTED_AT" \
    '{
      session_key: $session_key,
      project_slug: $project_slug,
      directory: $directory,
      started_at: $started_at
    }' 2>/dev/null)

  if [ -n "$PAYLOAD" ]; then
    curl -s -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      --connect-timeout 3 \
      --max-time 5 \
      > /dev/null 2>&1 &
  fi
fi

echo '{"continue": true}'
exit 0
