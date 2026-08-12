#!/bin/sh
# Harness standard v1: CLAUDE.md is a router, not an encyclopedia.
# Hard cap 40KB — move long-form detail into docs/ instead of growing this file.
set -eu

LIMIT=40960
FILE="${1:-CLAUDE.md}"

if [ ! -f "$FILE" ]; then
  echo "check-claude-md-size: $FILE not found" >&2
  exit 1
fi

SIZE=$(wc -c < "$FILE" | tr -d ' ')
if [ "$SIZE" -gt "$LIMIT" ]; then
  echo "check-claude-md-size: $FILE is ${SIZE} bytes (cap ${LIMIT})." >&2
  echo "Move detail into docs/ and leave a rule + link here (STANDARD.md §1)." >&2
  exit 1
fi
echo "check-claude-md-size: ok (${SIZE}/${LIMIT} bytes)"
