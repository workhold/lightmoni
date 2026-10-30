#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
state="$repo/.local-dev/042-cluster-demo"
label=cluster-applications-042
mkdir -p "$state/nodes"
docker build -t lightmoni-cluster-demo-node:local -f "$repo/examples/cluster-demo/scripts/Dockerfile.node" "$repo/examples/cluster-demo/scripts"
# The isolated engines reuse only the two QA workload images, never user images.
docker image save -o "$state/nodes/images.tar" lightmoni-cluster-demo-web:1.0.0 openresty/openresty:1.27.1.2-0-alpine
for node in standby secondary; do
  container="lightmoni-cluster-demo-$node"
  volume="lightmoni-cluster-demo-$node-engine"
  if docker container inspect "$container" >/dev/null 2>&1; then
    [ "$(docker inspect --format '{{index .Config.Labels "io.lightmoni.qa"}}' "$container")" = "$label" ] || exit 1
    docker start "$container" >/dev/null
  else
    docker volume create --label "io.lightmoni.qa=$label" "$volume" >/dev/null
    case "$node" in standby) subnet=172.30.42.1/24;; secondary) subnet=172.30.43.1/24;; esac
    docker run -d --privileged --name "$container" --label "io.lightmoni.qa=$label" \
      --mount "type=volume,src=$volume,dst=/var/lib/docker" \
      --mount "type=bind,src=$repo,dst=$repo" \
      --env "DEMO_REPO=$repo" --env "DEMO_STATE=$state" --env "DEMO_NODE=$node" --env "DEMO_NODE_BIP=$subnet" \
      lightmoni-cluster-demo-node:local >/dev/null
  fi
  attempt=0
  until docker exec "$container" docker info >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 120 ] || exit 1; sleep 1
  done
  docker exec "$container" docker image load -i "$state/nodes/images.tar" >/dev/null
done
DEMO_REPO="$repo" node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const nodes=['standby','secondary'].map(name=>{
  const [container]=JSON.parse(execFileSync('docker',['inspect','lightmoni-cluster-demo-'+name],{encoding:'utf8'}));
  return {name,container:container.Name.slice(1),address:container.NetworkSettings.Networks.bridge.IPAddress,machine_id:name==='standby'?'demo-a-standby':'demo-secondary',public_address:name==='standby'?'192.0.2.11':'192.0.2.20'};
});
writeFileSync(process.env.DEMO_REPO+'/.local-dev/042-cluster-demo/nodes.json',JSON.stringify(nodes,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({nodes,isolation:'Two independent Docker daemons and network namespaces on the same physical Docker host; no physical multi-machine claim'},null,2));
JS
