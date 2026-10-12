#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$root_dir"
if [ ! -f .env ]; then
  echo 'Copy .env.example to .env and configure the external ClickHouse connection first.' >&2
  echo 'For a bundled ClickHouse, use deploy/with-clickhouse/compose.yaml and its .env.example.' >&2
  exit 1
fi
exec docker compose --env-file .env -f compose.yaml up -d --build --wait "$@"
