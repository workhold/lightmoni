#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$root/runtime"
node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["../specs/071-agent-deployment-permissions/evidence/permissions-linux.mjs"],outfile:"../specs/071-agent-deployment-permissions/evidence/permissions-linux-bundle.mjs",bundle:true,platform:"node",format:"esm",external:["/work/deploy/agent/deployment-permissions.mjs"],banner:{js:"import {createRequire} from \"node:module\"; const require=createRequire(import.meta.url);"}})'
cd "$root"
docker build --pull=false --build-arg DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org}" -f specs/071-agent-deployment-permissions/evidence/Dockerfile -t lightmoni-agent-permissions:071 .
docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --cap-add CHOWN --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add NET_BIND_SERVICE \
  --sysctl net.ipv4.ip_unprivileged_port_start=1024 \
  --tmpfs /var/lib/lightmoni-agent:rw,mode=0700 --tmpfs /var/lib/lightmoni-web:rw,mode=0755 \
  --tmpfs /run:rw,mode=0755 --tmpfs /tmp:rw,mode=1777 \
  --mount "type=bind,src=$root,dst=/work,readonly" --entrypoint node lightmoni-agent-permissions:071 \
  /work/specs/071-agent-deployment-permissions/evidence/permissions-linux-bundle.mjs
