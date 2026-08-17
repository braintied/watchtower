#!/usr/bin/env bash
# session-key.sh — vendor detection + source column. Mutation-tested.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LIB="$ROOT/session-key.sh"
USER_HOOK="$(cd "$ROOT/.." && pwd)/session-user-message.sh"
ASST_HOOK="$(cd "$ROOT/.." && pwd)/session-assistant-messages.sh"
# shellcheck source=session-key.sh
source "$LIB"
PASS=0
FAIL=0

assert() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

# GROK_HOME / GROK_AGENT win even on UserPromptSubmit (the event the old
# whitelist dropped).
SESSION_ID=abc HOOK_EVENT=UserPromptSubmit GROK_HOME=/tmp/g \
  bash -c 'source "$0"; watchtower_resolve_session_key; printf "%s %s %s\n" "$SESSION_KEY" "$WATCHTOWER_SOURCE" "$WATCHTOWER_SOURCE_COLUMN"' "$LIB" \
  > /tmp/wt-key-grok-home.out
assert "GROK_HOME + UserPromptSubmit → grok:abc" \
  grep -qx 'grok:abc grok grok' /tmp/wt-key-grok-home.out

SESSION_ID=abc HOOK_EVENT=UserPromptSubmit GROK_AGENT=1 \
  env -u GROK_HOME \
  bash -c 'source "$0"; watchtower_resolve_session_key; printf "%s %s\n" "$SESSION_KEY" "$WATCHTOWER_SOURCE"' "$LIB" \
  > /tmp/wt-key-grok-agent.out
assert "GROK_AGENT + UserPromptSubmit → grok:abc" \
  grep -qx 'grok:abc grok' /tmp/wt-key-grok-agent.out

# No Grok env, no grok parent → claude (and the column is claude_code).
# This test file often runs inside a Grok session, so stub `ps` or the
# walk finds grok and the assertion is not testing the default.
fake_claude="$(mktemp -d)"
cat > "$fake_claude/ps" <<'EOF'
#!/bin/sh
argcmd=0
argppid=0
prev=""
for a in "$@"; do
  case "$prev" in
    -o)
      case "$a" in
        command=) argcmd=1 ;;
        ppid=) argppid=1 ;;
      esac
      ;;
  esac
  prev="$a"
done
if [ "$argcmd" = 1 ]; then
  printf '%s\n' '/bin/bash'
  exit 0
fi
if [ "$argppid" = 1 ]; then
  printf '%s\n' '1'
  exit 0
fi
exit 1
EOF
chmod +x "$fake_claude/ps"
SESSION_ID=xyz HOOK_EVENT=UserPromptSubmit \
  env -u GROK_HOME -u GROK_AGENT PATH="$fake_claude:/usr/bin:/bin" \
  bash -c 'source "$0"; watchtower_resolve_session_key; printf "%s %s %s\n" "$SESSION_KEY" "$WATCHTOWER_SOURCE" "$WATCHTOWER_SOURCE_COLUMN"' "$LIB" \
  > /tmp/wt-key-claude.out
assert "bare UserPromptSubmit → claude:xyz claude_code" \
  grep -qx 'claude:xyz claude claude_code' /tmp/wt-key-claude.out
rm -rf "$fake_claude"

assert "source_column claude" [ "$(watchtower_source_column claude)" = claude_code ]
assert "source_column grok" [ "$(watchtower_source_column grok)" = grok ]
assert "source_column codex" [ "$(watchtower_source_column codex)" = codex ]
assert "source_column kimi" [ "$(watchtower_source_column kimi)" = kimi ]

# Process walk on UserPromptSubmit with GROK_* unset. The 2026-08-16 hole
# was exactly this: the event was not on the whitelist, so a grok parent
# was ignored and the prompt landed on claude:.
fake="$(mktemp -d)"
cat > "$fake/ps" <<'EOF'
#!/bin/sh
argcmd=0
argppid=0
prev=""
for a in "$@"; do
  case "$prev" in
    -o)
      case "$a" in
        command=) argcmd=1 ;;
        ppid=) argppid=1 ;;
      esac
      ;;
  esac
  prev="$a"
done
if [ "$argcmd" = 1 ]; then
  printf '%s\n' '/opt/homebrew/bin/grok --resume abc'
  exit 0
fi
if [ "$argppid" = 1 ]; then
  printf '%s\n' '1'
  exit 0
fi
exit 1
EOF
chmod +x "$fake/ps"
SESSION_ID=walk HOOK_EVENT=UserPromptSubmit \
  env -u GROK_HOME -u GROK_AGENT PATH="$fake:/usr/bin:/bin" \
  bash -c 'source "$0"; watchtower_resolve_session_key; printf "%s %s\n" "$SESSION_KEY" "$WATCHTOWER_SOURCE"' "$LIB" \
  > /tmp/wt-key-walk.out
assert "UserPromptSubmit process-walk finds grok" \
  grep -qx 'grok:walk grok' /tmp/wt-key-walk.out
rm -rf "$fake"

# Mutation: the event whitelist is the bug. If it comes back, this fails.
assert "no event whitelist" \
  bash -c '! grep -E "session_start\|SessionStart\|post_tool_use" "$0"' "$LIB"

# Mutation: user/assistant writers must not hardcode claude_code.
assert "user-message uses source column" \
  bash -c '! grep -F "source: \"claude_code\"" "$0"' "$USER_HOOK"
assert "assistant-messages uses source column" \
  bash -c '! grep -F "source: \"claude_code\"" "$0"' "$ASST_HOOK"
assert "assistant-messages knows grok transcript" \
  grep -q 'chat_history.jsonl' "$ASST_HOOK"
assert "assistant-messages omits empty created_at" \
  bash -c '! grep -F "created_at: (if \$ts == \"\" then null" "$0"' "$ASST_HOOK"
INGEST_HOOK="$(cd "$ROOT/.." && pwd)/session-ingest.sh"
assert "ingest uses source column" \
  bash -c '! grep -F -- "--arg source \"claude_code\"" "$0"' "$INGEST_HOOK"

rm -f /tmp/wt-key-grok-home.out /tmp/wt-key-grok-agent.out /tmp/wt-key-claude.out /tmp/wt-key-walk.out

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
