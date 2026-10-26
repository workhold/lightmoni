#!/bin/sh
set -eu
exec node /opt/lightmoni/runtime/dist/server/admin-cli.js "$@"
