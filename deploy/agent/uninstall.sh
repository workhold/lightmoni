#!/bin/sh
set -eu
purge="false"
case "${1:-}" in '') ;; --purge) purge="true" ;; *) echo 'Usage: uninstall.sh [--purge]' >&2; exit 1 ;; esac
[ "$(id -u)" = "0" ] || { echo 'Run as root.' >&2; exit 1; }
systemctl disable --now lightmoni-agent.service || true
rm -f /etc/systemd/system/lightmoni-agent.service /usr/local/bin/lightmoni-agent
rm -rf /opt/lightmoni-agent
systemctl daemon-reload
if [ "$purge" = "true" ]; then
  rm -rf /etc/lightmoni-agent /var/lib/lightmoni-agent
  echo 'LightMoni Agent removed; configuration and accepted cached telemetry deleted by explicit --purge.'
else
  echo 'LightMoni Agent removed; configuration, identity and cached telemetry retained.'
fi
