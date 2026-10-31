#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo '{"error_code":"root_required"}'; exit 1; }
[ "$(uname -s)" = Linux ] || { echo '{"error_code":"unsupported_platform"}'; exit 1; }
case "${1:-}" in start) ;; *) echo '{"error_code":"invalid_command"}'; exit 1;; esac
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# The current bundled runtime is already installed and root managed. No global
# Node/npm, enrollment token or elevated long-lived Agent process is required.
exec /opt/lightmoni-agent/current/node "$helper_dir/update-runner.mjs" start
