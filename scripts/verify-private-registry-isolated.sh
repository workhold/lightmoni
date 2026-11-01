#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
mkdir -p "$repo/.local-dev"
task_dir=$(mktemp -d "$repo/.local-dev/registry-isolated-XXXXXX")
task_id="lm-059-$(date +%s)-$$"
task_network="$task_id-net"
task_engine="$task_id-engine"
owned() { [ "$(docker inspect --format '{{index .Config.Labels "io.lightmoni.qa"}}' "$1" 2>/dev/null || true)" = registry059 ]; }
cleanup() {
  if owned "$task_engine"; then docker rm -f "$task_engine" >/dev/null; fi
  docker network rm "$task_network" >/dev/null 2>&1 || true
  rm -rf "$task_dir"
}
trap cleanup EXIT INT TERM
mkdir "$task_dir/certs"
docker image save -o "$task_dir/images.tar" registry:3.0.0 alpine:3.23 openresty/openresty:1.27.1.2-0-alpine
docker network create --internal --label io.lightmoni.qa=registry059 "$task_network" >/dev/null
docker run -d --privileged --name "$task_engine" --label io.lightmoni.qa=registry059 --network "$task_network" \
  --mount "type=bind,src=$repo,dst=$repo" --mount "type=bind,src=$task_dir,dst=/qa" \
  --mount "type=bind,src=$task_dir/certs,dst=/etc/docker/certs.d" --env DOCKER_TLS_CERTDIR= \
  m.daocloud.io/docker.io/library/docker:27.5.1-dind dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 --tls=false >/dev/null
attempt=0
until docker exec "$task_engine" docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; do
  attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1
done
docker exec "$task_engine" docker --host unix:///var/run/docker.sock image load -i /qa/images.tar >/dev/null
docker run --rm --network "container:$task_engine" --env DOCKER_HOST=tcp://127.0.0.1:2375 \
  --env LIGHTMONI_REGISTRY_LIVE=1 --env LIGHTMONI_REGISTRY_CLIENT_TLS=1 \
  --mount "type=bind,src=$repo,dst=$repo" --mount "type=bind,src=$task_dir/certs,dst=/etc/docker/certs.d" \
  --workdir "$repo" lightmoni-cluster-demo-qa:local node scripts/verify-private-registry.mjs
