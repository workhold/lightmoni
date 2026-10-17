#!/bin/sh
set -eu
launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$launcher_dir/lightmoni-agent-runtime/node" ]; then
  runtime_dir="$launcher_dir/lightmoni-agent-runtime"
else
  runtime_dir="/opt/lightmoni-agent/current"
fi
[ -x "$runtime_dir/node" ] || { echo 'LightMoni Agent bundled Node runtime is missing; reinstall the release bundle.' >&2; exit 1; }
exec "$runtime_dir/node" "$runtime_dir/app/runtime/dist/agent/main.js" "$@"
