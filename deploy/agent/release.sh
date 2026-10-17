#!/bin/sh
set -eu
version="${1:-0.1.0}"
output="${2:-runtime/downloads}"
case "$version" in *[!0-9A-Za-z._-]*|'') echo 'Invalid fixed version.' >&2; exit 1 ;; esac
exec node scripts/build-agent-release.mjs "$version" "$output"
