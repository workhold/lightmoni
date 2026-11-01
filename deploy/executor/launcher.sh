#!/bin/sh
set -eu
exec /opt/lightmoni-executor/current/node /opt/lightmoni-executor/current/app/runtime/dist/privileged-executor/main.js "$@"
