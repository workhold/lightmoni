#!/bin/sh
set -eu
dockerd --host unix:///var/run/docker.sock --bip "$DEMO_NODE_BIP" --storage-driver overlay2 >/var/log/demo-dockerd.log 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT INT TERM
attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 120 ]; then printf '%s\n' 'Isolated Docker node did not become ready'; exit 1; fi
  sleep 1
done
node "$DEMO_REPO/examples/cluster-demo/scripts/node-worker.mjs" &
worker=$!
trap 'kill "$worker" "$daemon" 2>/dev/null || true' EXIT INT TERM
wait "$worker"
