#!/usr/bin/env bash
# One writer for "which session_key does this hook event belong to?".
#
# New sessions write `source:<uuid>` (`grok:` / `claude:` / `codex:` …).
# Old Claude cwd slugs still bind via session_terminals. Two copies of the
# key rule is how bind and PostToolUse disagreed (2026-08-13). Every hook
# sources this file.
#
# Requires: SESSION_ID. Optional: DIRECTORY, CWD, HOOK_EVENT (unused for
# detection — kept so callers can keep setting it).
# Sets: WATCHTOWER_SOURCE (claude|grok|codex|cursor|opencode|kimi|zai|minimax),
#       SESSION_KEY, WATCHTOWER_SOURCE_COLUMN (coding_sessions.source value).
#
# 2026-08-16: UserPromptSubmit was missing from an event whitelist, so Grok
# (which loads ~/.claude/settings.json) wrote the human prompt as
# source=claude_code on a claude:<uuid> twin. Tools still landed on grok:
# because PostToolUse was on the list AND GROK_AGENT is set in tool
# subprocesses. UserPromptSubmit is not a tool subprocess, so GROK_AGENT
# is often unset and the walk never ran. Measured: 0 grok role=user rows
# in 7 days against 421 grok sessions. Walk every event. Do not put the
# event name back on a whitelist.

watchtower_source_column() {
  case "${1:-${WATCHTOWER_SOURCE:-claude}}" in
    claude) printf '%s\n' claude_code ;;
    *) printf '%s\n' "${1:-${WATCHTOWER_SOURCE:-claude}}" ;;
  esac
}

# Detect the vendor that spawned this hook. Env first (cheap, reliable on
# tool subprocesses), then a process walk that runs for EVERY event.
watchtower_detect_source() {
  if [ -n "${GROK_AGENT:-}" ] || [ -n "${GROK_HOME:-}" ]; then
    printf '%s\n' grok
    return 0
  fi

  _walk=$PPID
  for _ in 1 2 3 4 5 6 7 8; do
    [ -z "$_walk" ] || [ "$_walk" = 1 ] && break
    _cmd=$(ps -p "$_walk" -o command= 2>/dev/null || true)
    _base=$(basename "${_cmd%% *}" 2>/dev/null || true)
    case "$_base" in
      grok)
        printf '%s\n' grok
        return 0
        ;;
      claude)
        printf '%s\n' claude
        return 0
        ;;
      codex)
        printf '%s\n' codex
        return 0
        ;;
      kimi)
        printf '%s\n' kimi
        return 0
        ;;
      opencode)
        printf '%s\n' opencode
        return 0
        ;;
      cursor-agent|cursor)
        printf '%s\n' cursor
        return 0
        ;;
      minimax)
        printf '%s\n' minimax
        return 0
        ;;
      zai)
        printf '%s\n' zai
        return 0
        ;;
    esac
    case "$_cmd" in
      *'/grok '*|*/grok|'grok '*|grok)
        printf '%s\n' grok
        return 0
        ;;
    esac
    _walk=$(ps -p "$_walk" -o ppid= 2>/dev/null | tr -d ' ')
  done

  printf '%s\n' claude
  return 0
}

watchtower_resolve_session_key() {
  _sid="${SESSION_ID:-}"
  if [ -z "$_sid" ]; then
    SESSION_KEY=""
    WATCHTOWER_SOURCE=""
    WATCHTOWER_SOURCE_COLUMN=""
    return 1
  fi

  WATCHTOWER_SOURCE=$(watchtower_detect_source)
  WATCHTOWER_SOURCE_COLUMN=$(watchtower_source_column "$WATCHTOWER_SOURCE")
  SESSION_KEY="${WATCHTOWER_SOURCE}:${_sid}"
  return 0
}
