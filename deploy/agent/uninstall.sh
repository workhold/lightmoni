#!/bin/sh
set -eu
purge="false"
case "${1:-}" in '') ;; --purge) purge="true" ;; *) echo 'Usage: uninstall.sh [--purge]' >&2; exit 1 ;; esac
[ "$(id -u)" = "0" ] || { echo 'Run as root.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }
umask 077
lock=/run/lightmoni-agent-lifecycle.lock
mkdir "$lock" || { echo 'Agent lifecycle operation already in progress.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
# Systemd query failures cannot establish that a service is absent.
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
if [ -e /var/lib/lightmoni-agent/operations/execution.lock ] || { [ -f /var/lib/lightmoni-agent/agent-job-state.json ] && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/agent-job-state.json; } || { [ -f /var/lib/lightmoni-agent/task-run-state.json ] && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/task-run-state.json; }; then
  echo 'Agent has an unfinished operation; files retained.' >&2; exit 1
fi
if [ "$load_state" != "not-found" ]; then
  [ "$load_state" = loaded ] && [ "$fragment" = /etc/systemd/system/lightmoni-agent.service ] || { echo 'Non-managed Agent unit; files retained.' >&2; exit 1; }
  systemctl stop lightmoni-agent.service
  state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
  case "$state" in inactive|failed) ;; *) echo 'Agent did not stop; files retained.' >&2; exit 1;; esac
  systemctl disable lightmoni-agent.service
else
  state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
  case "$state" in inactive|failed) ;; *) echo 'Agent state is uncertain; files retained.' >&2; exit 1;; esac
fi
rm -f /etc/systemd/system/lightmoni-agent.service /usr/local/bin/lightmoni-agent
rm -rf /opt/lightmoni-agent
systemctl daemon-reload
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
[ "$load_state" = not-found ] || { echo 'Agent unit still exists; inspect locally.' >&2; exit 1; }
if [ "$purge" = "true" ]; then
  rm -rf /etc/lightmoni-agent /var/lib/lightmoni-agent
  echo 'LightMoni Agent removed; configuration and accepted cached telemetry deleted by explicit --purge.'
else
  echo 'LightMoni Agent removed; configuration, identity and cached telemetry retained.'
fi
