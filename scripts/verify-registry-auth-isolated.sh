#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
dependency_dir=$(CDPATH= cd -- "$repo/runtime/node_modules" && pwd -P)
source_repo=$(dirname "$(dirname "$dependency_dir")")
mkdir -p "$repo/.local-dev"
task_dir=$(mktemp -d "$repo/.local-dev/registry-auth-XXXXXX")
task_id="lm-registry-auth-$(date +%s)-$$"
cleanup(){ docker rm -f "$task_id" >/dev/null 2>&1 || true; docker network rm "$task_id-net" >/dev/null 2>&1 || true; rm -rf "$task_dir"; }
trap cleanup EXIT INT TERM
mkdir "$task_dir/certs"
docker image save -o "$task_dir/images.tar" registry:3.0.0 alpine:3.23
docker network create --internal --label io.lightmoni.qa=registry111 "$task_id-net" >/dev/null
docker run -d --privileged --name "$task_id" --label io.lightmoni.qa=registry111 --network "$task_id-net" --mount "type=bind,src=$task_dir,dst=/qa" --mount "type=bind,src=$task_dir/certs,dst=/etc/docker/certs.d" --env DOCKER_TLS_CERTDIR= m.daocloud.io/docker.io/library/docker:27.5.1-dind dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 --tls=false >/dev/null
attempt=0
until docker exec "$task_id" docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; do attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1; done
docker exec "$task_id" docker image load -i /qa/images.tar >/dev/null
set -- --mount "type=bind,src=$repo,dst=$repo"
if [ "$source_repo" != "$repo" ]; then set -- "$@" --mount "type=bind,src=$source_repo,dst=$source_repo,readonly"; fi
docker run --rm --network "container:$task_id" --env DOCKER_HOST=tcp://127.0.0.1:2375 --env LIGHTMONI_REGISTRY_AUTH_LIVE=1 "$@" --mount "type=bind,src=$task_dir,dst=/qa" --workdir "$repo" lightmoni-cluster-demo-qa:local node scripts/verify-registry-auth-live.mjs
