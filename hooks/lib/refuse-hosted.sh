#!/usr/bin/env bash
# Refuse Braintied production hosts from the Apache capture client.
#
# This tree is code you run. It is not a login to Braintied's Fly
# indexer or Cortex. ora-watchtower.fly.dev is ours. A stranger's
# session must never land there.
#
# Returns 0 when the URL is ours (caller must skip the POST).
# Returns 1 when the URL is the caller's (localhost, their host).
watchtower_is_braintied_production() {
  _url=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  case "$_url" in
    *ora-watchtower.fly.dev*|*ora-watchtower.internal*)
      return 0
      ;;
  esac
  return 1
}
