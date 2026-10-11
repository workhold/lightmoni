#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$root_dir"
if [ ! -f .env ]; then
  umask 077
  password=$(openssl rand -hex 24)
  server_port=${LIGHTMONI_PORT:-8080}
  external_url=${LIGHTMONI_EXTERNAL_URL:-http://localhost:$server_port}
  { printf 'CLICKHOUSE_PASSWORD=%s\n' "$password"; printf 'LIGHTMONI_PORT=%s\n' "$server_port"; printf 'LIGHTMONI_EXTERNAL_URL=%s\n' "$external_url"; } > .env
fi
docker compose --env-file .env -p lightmoni -f deploy/server/compose.yml up -d --build
