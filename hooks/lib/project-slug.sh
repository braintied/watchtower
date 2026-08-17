#!/usr/bin/env bash
# One writer for "which project does this directory belong to?".
#
# Every session hook used to carry its own copy of the ladder:
#
#   REMOTE_URL=$(git -C "$DIR" remote get-url origin 2>/dev/null)
#   PROJECT_DIR=$(echo "$REMOTE_URL" | sed 's|.*/||; s|\.git$||')   # else basename
#
# Five copies, all missing the same two things the TypeScript resolver has:
#
#   1. No `--git-common-dir` rung. A linked worktree WITHOUT an origin remote
#      resolves to the worktree's own name, which is never a project. There are
#      ~390 live worktrees on this machine.
#   2. No scrub of the inherited environment. A hook inherits whatever the
#      shell exported, and GIT_DIR / GIT_CEILING_DIRECTORIES override `git -C`
#      — so the answer can be another repository entirely, or nothing at all.
#
# That mattered more than it looks: claude_code is the source of EVERY session
# captured in the last seven days (1399 of them, 487 unattributed), so these
# scripts were the attribution path, and the resolver shipped in the package
# was never on it. Delegating to `watchtower resolve-project` makes the shell
# and the library agree by construction instead of by review.
#
# The inline ladder below is kept ONLY as a fallback for a machine where the
# CLI is not installed yet. It is deliberately identical to the old behaviour,
# so a missing CLI degrades to what these hooks already did rather than to
# nothing.

# Resolutions are stable per directory, and these hooks run on every message —
# a node spawn on that path would be felt. Cache keyed by directory so the
# spawn happens once per directory, then expires so a re-pointed remote or a
# repo that gained an origin is picked up without manual intervention.
WATCHTOWER_SLUG_CACHE_DIR="${WATCHTOWER_SLUG_CACHE_DIR:-$HOME/.cache/watchtower/project-slug}"
WATCHTOWER_SLUG_TTL_MIN="${WATCHTOWER_SLUG_TTL_MIN:-1440}"

# Fallback: the pre-existing shell ladder, unchanged.
_watchtower_slug_fallback() {
  _dir="$1"
  _slug=""
  _remote=$(git -C "$_dir" remote get-url origin 2>/dev/null)
  if [ -n "$_remote" ]; then
    _slug=$(printf '%s' "$_remote" | sed 's|.*/||; s|\.git$||')
  fi
  if [ -z "$_slug" ]; then
    _slug=$(basename "$_dir")
  fi
  printf '%s' "$_slug"
}

# resolve_project_slug <directory> -> prints the slug (may be empty)
resolve_project_slug() {
  _dir="$1"
  [ -n "$_dir" ] || return 0

  # `cksum` is in POSIX and present everywhere; the key only needs to be stable
  # and collision-resistant enough for a per-machine cache of directory names.
  _key=$(printf '%s' "$_dir" | cksum | tr -d ' /')
  _cache_file="$WATCHTOWER_SLUG_CACHE_DIR/$_key"

  if [ -f "$_cache_file" ] \
    && [ -z "$(find "$_cache_file" -mmin "+$WATCHTOWER_SLUG_TTL_MIN" 2>/dev/null)" ]; then
    cat "$_cache_file" 2>/dev/null
    return 0
  fi

  _slug=""
  if command -v watchtower > /dev/null 2>&1; then
    # Non-zero exit means "no answer", which is distinct from an empty slug and
    # must fall through rather than be cached as the truth.
    _slug=$(watchtower resolve-project "$_dir" 2>/dev/null) || _slug=""
  fi
  if [ -z "$_slug" ]; then
    _slug=$(_watchtower_slug_fallback "$_dir")
  fi

  if [ -n "$_slug" ] && mkdir -p "$WATCHTOWER_SLUG_CACHE_DIR" 2>/dev/null; then
    printf '%s' "$_slug" > "$_cache_file" 2>/dev/null || true
  fi
  printf '%s' "$_slug"
}

# resolve_cwd_is_repo <directory> -> prints `true` or `false`.
#
# The second fact the webhook needs and the filesystem alone can answer: was
# the session's cwd inside a git checkout? The server uses it to tell
# `non_repo` ("we checked, it was `~`") from `unresolved` ("it WAS a repo and
# the slug still did not match a project"), which is the whole point of
# attribution_status. Until 2026-08-16 no Claude Code hook sent it, so 43% of a
# week's sessions read `unresolved` and nothing could say whether that number
# was a resolver gap or honest non-repo work.
#
# Same environment scrub as `cwdIsRepo` in src/project-slug.ts, for the same
# reason: a hook inherits GIT_DIR / GIT_WORK_TREE / GIT_CEILING_DIRECTORIES from
# whatever spawned it, and `git -C` is advisory next to those — an inherited
# GIT_DIR answers for the HOOK's repository, and a ceiling covering the checkout
# makes a real repo answer "not a git repository". Deliberately NOT cached
# alongside the slug: it is one `rev-parse`, and the two answers must not
# disagree about the same directory because one of them was stale.
#
# Prints `false` when the directory is empty or missing — an unknown cwd is not
# a repo — and never fails, so a hook that sources this cannot be broken by it.
resolve_cwd_is_repo() {
  _dir="$1"
  if [ -z "$_dir" ] || [ ! -d "$_dir" ]; then
    printf 'false'
    return 0
  fi
  if env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
         -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_PREFIX \
         -u GIT_CEILING_DIRECTORIES \
         git -C "$_dir" rev-parse --git-common-dir > /dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
  return 0
}
