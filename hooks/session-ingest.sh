#!/bin/bash
# Session Ingest Hook — Auto-POST session data to Watchtower on session end
#
# Fires on Claude Code Stop event. Collects session metadata, message
# content, AND tool call details from JSONL files, then POSTs to the
# Watchtower webhook for indexing and AI analysis.
#
# Captured data:
#   - User messages (full text)
#   - Assistant responses (text only, no thinking blocks)
#   - Tool calls: Edit diffs (truncated), Bash commands, Grep/Glob queries,
#     Agent delegations, WebSearch queries, file paths
#   - Metadata: tools used, files touched, duration, timestamps
#
# Env: WATCHTOWER_SESSION_WEBHOOK_URL (defaults to local dev server)

INPUT=$(cat)

SESSION_ID=""
DIRECTORY=""
if command -v jq &> /dev/null; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.sessionId // .session_id // ""' 2>/dev/null)
  DIRECTORY=$(echo "$INPUT" | jq -r '.directory // ""' 2>/dev/null)
fi

if [ -z "$DIRECTORY" ]; then
  DIRECTORY=$(pwd)
fi

if [ -z "$SESSION_ID" ]; then
  echo '{"continue": true}'
  exit 0
fi

WEBHOOK_URL="${WATCHTOWER_SESSION_WEBHOOK_URL:-http://localhost:5003/webhooks/session}"
PROJECT_DIR=$(basename "$DIRECTORY")

CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
ENCODED_DIR=$(echo "$DIRECTORY" | sed 's|/|-|g')

# Find session directory
SESSION_DIR=""
if [ -d "$CLAUDE_PROJECTS_DIR/$ENCODED_DIR/$SESSION_ID" ]; then
  SESSION_DIR="$CLAUDE_PROJECTS_DIR/$ENCODED_DIR/$SESSION_ID"
else
  for PROJECT_PATH in "$CLAUDE_PROJECTS_DIR"/*/; do
    if [ -d "${PROJECT_PATH}${SESSION_ID}" ]; then
      SESSION_DIR="${PROJECT_PATH}${SESSION_ID}"
      ENCODED_DIR=$(basename "$PROJECT_PATH")
      break
    fi
  done
fi

if [ -z "$SESSION_DIR" ]; then
  echo '{"continue": true}'
  exit 0
fi

MESSAGE_COUNT=0
FILES_TOUCHED="[]"
TOOLS_USED="[]"
FIRST_TIMESTAMP=""
LAST_TIMESTAMP=""
RAW_CONTENT=""

SUBAGENTS_DIR="$SESSION_DIR/subagents"
if [ -d "$SUBAGENTS_DIR" ] && command -v jq &> /dev/null; then
  # Single pass: extract metadata + rich content with tool call details
  EXTRACTED=$(cat "$SUBAGENTS_DIR"/*.jsonl 2>/dev/null | jq -s '
    # Helper: summarize a tool call input
    def tool_summary:
      if .name == "Edit" then
        "Edit " + (.input.file_path // "?") + ": \"" + ((.input.old_string // "")[0:100]) + "\" -> \"" + ((.input.new_string // "")[0:100]) + "\""
      elif .name == "Write" then
        "Write " + (.input.file_path // "?")
      elif .name == "Read" then
        "Read " + (.input.file_path // "?")
      elif .name == "Bash" then
        "Bash: " + ((.input.command // "")[0:200])
      elif .name == "Grep" then
        "Grep \"" + (.input.pattern // "") + "\" in " + (.input.path // ".")
      elif .name == "Glob" then
        "Glob \"" + (.input.pattern // "") + "\""
      elif .name == "Agent" then
        "Agent(" + (.input.description // "") + "): " + ((.input.prompt // "")[0:150])
      elif .name == "WebSearch" then
        "WebSearch: " + (.input.query // "")
      elif .name == "WebFetch" then
        "WebFetch: " + (.input.url // "")
      else
        .name + "(" + ((.input | keys[0:3] | map(. + "=" + ((.input[.] // "") | tostring)[0:80]) | join(", ")) // "") + ")"
      end;

    {
      message_count: length,
      tools_used: [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name] | unique,
      files_touched: [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and (.name == "Edit" or .name == "Write" or .name == "Read")) | .input.file_path // empty] | unique | map(select(length > 0)),
      first_timestamp: ([.[] | .timestamp // empty | select(length > 0)] | sort | first // null),
      last_timestamp: ([.[] | .timestamp // empty | select(length > 0)] | sort | last // null),
      raw_content: ([.[] | (
        if .type == "user" then
          "[user] " + (.message.content // "" | tostring)
        elif .type == "assistant" then
          (
            # Text content
            ([.message.content[]? | select(.type == "text") | .text] | join("\n") | if length > 0 then "[assistant] " + . else "" end),
            # Tool call summaries
            ([.message.content[]? | select(.type == "tool_use") | "  > " + tool_summary] | join("\n"))
          ) | map(select(length > 0)) | join("\n")
        else empty end
      )] | join("\n") | .[0:50000])
    }
  ' 2>/dev/null)

  if [ -n "$EXTRACTED" ] && [ "$EXTRACTED" != "null" ]; then
    MESSAGE_COUNT=$(echo "$EXTRACTED" | jq -r '.message_count // 0')
    TOOLS_USED=$(echo "$EXTRACTED" | jq -c '.tools_used // []')
    FILES_TOUCHED=$(echo "$EXTRACTED" | jq -c '.files_touched // []')
    FIRST_TIMESTAMP=$(echo "$EXTRACTED" | jq -r '.first_timestamp // ""')
    LAST_TIMESTAMP=$(echo "$EXTRACTED" | jq -r '.last_timestamp // ""')
    RAW_CONTENT=$(echo "$EXTRACTED" | jq -r '.raw_content // ""')
  fi
elif [ -d "$SUBAGENTS_DIR" ]; then
  MESSAGE_COUNT=$(cat "$SUBAGENTS_DIR"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
fi

# Calculate duration
DURATION_MINUTES=""
if [ -n "$FIRST_TIMESTAMP" ] && [ -n "$LAST_TIMESTAMP" ] && [ "$FIRST_TIMESTAMP" != "null" ] && [ "$LAST_TIMESTAMP" != "null" ]; then
  FIRST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRST_TIMESTAMP%%.*}" "+%s" 2>/dev/null)
  LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_TIMESTAMP%%.*}" "+%s" 2>/dev/null)
  if [ -n "$FIRST_EPOCH" ] && [ -n "$LAST_EPOCH" ]; then
    DURATION_SECONDS=$((LAST_EPOCH - FIRST_EPOCH))
    DURATION_MINUTES=$((DURATION_SECONDS / 60))
  fi
fi

SESSION_KEY="$ENCODED_DIR/$SESSION_ID"

# Build payload
PAYLOAD=$(jq -n \
  --arg session_key "$SESSION_KEY" \
  --arg source "claude_code" \
  --arg project_slug "$PROJECT_DIR" \
  --argjson message_count "${MESSAGE_COUNT:-0}" \
  --argjson files_touched "${FILES_TOUCHED:-[]}" \
  --argjson tools_used "${TOOLS_USED:-[]}" \
  --arg session_started_at "${FIRST_TIMESTAMP:-}" \
  --arg session_ended_at "${LAST_TIMESTAMP:-}" \
  --arg raw_content "${RAW_CONTENT:-}" \
  '{
    session_key: $session_key,
    source: $source,
    project_slug: $project_slug,
    message_count: $message_count,
    files_touched: $files_touched,
    tools_used: $tools_used,
    session_started_at: (if $session_started_at == "" then null else $session_started_at end),
    session_ended_at: (if $session_ended_at == "" then null else $session_ended_at end),
    metadata: {
      raw_content: (if $raw_content == "" then null else $raw_content end),
      session_dir: "'"$SESSION_DIR"'",
      source_hook: "session-ingest.sh"
    }
  }' 2>/dev/null)

if [ -n "$DURATION_MINUTES" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --argjson dur "$DURATION_MINUTES" '.duration_minutes = $dur' 2>/dev/null)
fi

# POST to webhook (fire-and-forget, non-blocking)
if [ -n "$PAYLOAD" ]; then
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 5 \
    --max-time 30 \
    > /dev/null 2>&1 &
fi

echo '{"continue": true}'
exit 0
