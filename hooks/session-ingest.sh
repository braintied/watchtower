#!/bin/bash
# OSS Stop hook — webhook only. Synced from @braintied/watchtower 8.1.0.
# The fleet hook that writes to Braintied's hosted store is not in this tree.
#
# Env: WATCHTOWER_SESSION_WEBHOOK_URL (default http://localhost:5003/webhooks/session)

INPUT=$(cat)

SESSION_ID=""
DIRECTORY=""
TRANSCRIPT_PATH=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.sessionId // .session_id // ""' 2>/dev/null)
  DIRECTORY=$(printf '%s' "$INPUT" | jq -r '.cwd // .workspaceRoot // .directory // ""' 2>/dev/null)
  TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // .transcriptPath // ""' 2>/dev/null)
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

# Find the transcript. Claude's Stop input names it in transcript_path; that is
# the answer whenever it is present. Without it, search by session id under
# ${CLAUDE_CONFIG_DIR:-~/.claude}/projects. The encoded directory name is not
# rebuilt from cwd: Claude replaces every non-alphanumeric and hashes long paths.
TRANSCRIPT=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  TRANSCRIPT="$TRANSCRIPT_PATH"
else
  for CANDIDATE in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"/*/"$SESSION_ID".jsonl; do
    if [ -f "$CANDIDATE" ]; then
      TRANSCRIPT="$CANDIDATE"
      break
    fi
  done
fi

# Main transcript plus subagents/*.jsonl, which live in <transcript minus .jsonl>/.
TRANSCRIPT_FILES=()
if [ -n "$TRANSCRIPT" ]; then
  TRANSCRIPT_FILES+=("$TRANSCRIPT")
  for SUB in "${TRANSCRIPT%.jsonl}"/subagents/*.jsonl; do
    [ -f "$SUB" ] && TRANSCRIPT_FILES+=("$SUB")
  done
fi
if [ "${#TRANSCRIPT_FILES[@]}" -eq 0 ]; then
  echo '{"continue": true}'
  exit 0
fi

RAW_CONTENT=""
MESSAGE_COUNT=0
if command -v jq >/dev/null 2>&1; then
  # Streamed line by line (a transcript can run to hundreds of MB), then
  # aggregated. A newline after each file keeps a torn last line from gluing
  # onto the next file; fromjson? skips it. tool_result echoes are not content.
  EXTRACTED=$(for TF in "${TRANSCRIPT_FILES[@]}"; do cat "$TF" 2>/dev/null; echo; done | jq -R -c '
    fromjson? | select(type == "object" and (.type == "user" or .type == "assistant"))
    | (if (.message.content | type) == "array" then .message.content else [] end) as $parts
    | if .type == "user" then
        ((if (.message.content | type) == "string" then .message.content
          else ([$parts[] | select(.type == "text") | .text] | join("\n")) end) // "")
        | if length > 0 then "[user] " + .[0:4000] else "" end
      else
        ([$parts[] | select(.type == "text") | .text] | join("\n"))
        | if length > 0 then "[assistant] " + .[0:4000] else "" end
      end
  ' 2>/dev/null | jq -s '{
    message_count: length,
    raw_content: ([.[] | select(length > 0)] | join("\n") | .[0:50000])
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
  --arg transcript_path "$TRANSCRIPT" \
  '{
    session_key: $session_key,
    source: $source,
    project_slug: $project_slug,
    message_count: $message_count,
    metadata: { raw_content: (if $raw_content == "" then null else $raw_content end), source_hook: "oss-session-ingest", transcript_path: $transcript_path }
  }' 2>/dev/null)

if [ -n "$PAYLOAD" ]; then
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 5 --max-time 30 >/dev/null 2>&1 &
fi

echo '{"continue": true}'
exit 0
