#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$root_dir"
if [ ! -f .env ]; then
  echo 'Copy .env.example to .env and set LIGHTMONI_CH_PASSWORD first.' >&2
  exit 1
fi
docker compose --env-file .env -f compose.yaml pull lightmoni
exec docker compose --env-file .env -f compose.yaml up -d --no-build --wait "$@"
