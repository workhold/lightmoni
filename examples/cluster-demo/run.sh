#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
state="$repo/.local-dev/042-cluster-demo"
qa=lightmoni-cluster-demo-qa
relay=lightmoni-cluster-demo-relay
image=lightmoni-cluster-demo-web:1.0.0
label=cluster-applications-042
command=${1:-up}
mkdir -p "$state"
chmod 700 "$state"
owned() {
  [ "$(docker inspect --format '{{index .Config.Labels "io.lightmoni.qa"}}' "$1" 2>/dev/null || true)" = "$label" ]
}
control() { docker exec "$qa" node "$repo/examples/cluster-demo/scripts/control.mjs" "$1"; }
case "$command" in
  up)
    if docker container inspect "$qa" >/dev/null 2>&1; then
      owned "$qa" || { printf '%s\n' 'Container name is already used by a different owner'; exit 1; }
      if [ "$(docker inspect --format '{{.State.Running}}' "$qa")" = true ]; then control status; exit; fi
      docker rm "$qa" >/dev/null
    fi
    npm --prefix "$repo/runtime" run build
    npm --prefix "$repo/web" run build
    docker build -t "$image" "$repo/examples/cluster-demo/web"
    docker build -t lightmoni-cluster-demo-qa:local -f "$repo/examples/cluster-demo/scripts/Dockerfile.qa" "$repo/examples/cluster-demo/scripts"
    docker image inspect mysql:8.4 >/dev/null 2>&1 || docker pull mysql:8.4
    docker image inspect openresty/openresty:1.27.1.2-0-alpine >/dev/null 2>&1 || docker pull openresty/openresty:1.27.1.2-0-alpine
    if [ -f "$state/nodes.json" ]; then "$repo/examples/cluster-demo/scripts/nodes.sh"; fi
    socket=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
    case "$socket" in unix://*) socket=${socket#unix://};; *) printf '%s\n' 'This demo requires a local Unix Docker socket'; exit 1;; esac
    docker run -d --network host --name "$qa" --label "io.lightmoni.qa=$label" \
      --mount "type=bind,src=$repo,dst=$repo" --mount "type=bind,src=$socket,dst=/var/run/docker.sock" \
      --workdir "$repo" --env "DEMO_STATE=$state" --env "DEMO_IMAGE=$image" \
      lightmoni-cluster-demo-qa:local node examples/cluster-demo/scripts/harness.mjs >/dev/null
    if docker container inspect "$relay" >/dev/null 2>&1; then
      owned "$relay" || { printf '%s\n' 'Relay name is already used by a different owner'; exit 1; }
      docker rm -f "$relay" >/dev/null
    fi
    gateway=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
    docker run -d --name "$relay" --label "io.lightmoni.qa=$label" \
      --env "DEMO_HOST=$gateway" -p 127.0.0.1:18080:8080 -p 127.0.0.1:18081:8081 -p 127.0.0.1:18443:8443 \
      --env DEMO_STATE=/demo-state -p 127.0.0.1:19043:8090 \
      --mount "type=bind,src=$state,dst=/demo-state,readonly" \
      --mount "type=bind,src=$repo/examples/cluster-demo/scripts/relay.mjs,dst=/relay.mjs,readonly" \
      node:24.15.0-bookworm-slim node /relay.mjs >/dev/null
    printf '%s\n' 'Demo is starting. Run ./examples/cluster-demo/run.sh status until ready.' 'Website: http://127.0.0.1:18080   Admin port: http://127.0.0.1:18081' 'QA workbench: http://127.0.0.1:19043/qa/workbench'
    ;;
  nodes-up)
    npm --prefix "$repo/runtime" run build
    docker build -t "$image" "$repo/examples/cluster-demo/web"
    docker image inspect openresty/openresty:1.27.1.2-0-alpine >/dev/null 2>&1 || docker pull openresty/openresty:1.27.1.2-0-alpine
    "$repo/examples/cluster-demo/scripts/nodes.sh"
    ;;
  status|verify|rebuild|stop|start|failover) owned "$qa" || { printf '%s\n' 'Demo QA container not found'; exit 1; }; control "$command";;
  down)
    if owned "$qa"; then control stop; docker rm -f "$qa" >/dev/null; fi
    if owned "$relay"; then docker rm -f "$relay" >/dev/null; fi
    for node in lightmoni-cluster-demo-standby lightmoni-cluster-demo-secondary; do
      if owned "$node"; then docker stop "$node" >/dev/null; fi
    done
    printf '%s\n' 'Demo containers stopped. Persistent MySQL and isolated control-plane data remain in .local-dev/042-cluster-demo.'
    ;;
  *) printf '%s\n' 'Usage: run.sh [up|nodes-up|status|verify|rebuild|failover|stop|start|down]'; exit 1;;
esac
