#!/bin/sh
# Offline removal. Platform identity revocation is a separate required action.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
[ "$(id -u)" = 0 ] || { echo 'executor_uninstall_requires_root' >&2; exit 1; }
confirmed=no
expected_executor_id=''
expected_install_generation=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm-remove-executor) confirmed=yes; shift ;;
    --expected-executor-id) [ "$#" -ge 2 ] || exit 2; expected_executor_id="$2"; shift 2 ;;
    --expected-install-generation) [ "$#" -ge 2 ] || exit 2; expected_install_generation="$2"; shift 2 ;;
    *) echo 'executor_uninstall_invalid_argument' >&2; exit 2 ;;
  esac
done
[ "$confirmed" = yes ] || { echo 'Usage: lightmoni-executor-uninstall --confirm-remove-executor' >&2; exit 2; }
if [ -n "$expected_executor_id" ] || [ -n "$expected_install_generation" ]; then
  case "$expected_executor_id" in *[!A-Za-z0-9_-]*|'') echo 'executor_uninstall_invalid_identity' >&2; exit 2 ;; esac
  case "$expected_install_generation" in *[!0-9]*|''|0) echo 'executor_uninstall_invalid_generation' >&2; exit 2 ;; esac
fi
# Keep this standalone fragment identical to executorHostLockShell('lifecycle').
# A contract test checks it against the server's shared fixed lock helper.
command -v flock >/dev/null 2>&1 || exit 1
for executor_parent in / /run; do
  [ -d "$executor_parent" ] && [ ! -L "$executor_parent" ] && [ "$(stat -c %u "$executor_parent")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_parent") & 0022)) -eq 0 ] || exit 1
done
executor_lock=/run/lightmoni-executor-lifecycle.lock
if [ -e "$executor_lock" ] || [ -L "$executor_lock" ]; then
  [ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
fi
exec 9>>"$executor_lock"
[ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
[ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
[ -f /proc/self/fd/9 ] || exit 1
executor_lock_path_identity=$(stat -c '%d:%i:%u:%a' -- "$executor_lock") || exit 1
executor_lock_fd_identity=$(stat -Lc '%d:%i:%u:%a' -- /proc/self/fd/9) || exit 1
[ "$executor_lock_path_identity" = "$executor_lock_fd_identity" ] || exit 1
flock -n 9 || exit 1
node=/opt/lightmoni-executor/current/node
for item in /opt /opt/lightmoni-executor /opt/lightmoni-executor/releases /usr /usr/local /usr/local/bin /usr/local/bin/lightmoni-executor /usr/local/sbin /usr/local/sbin/lightmoni-executor-uninstall /etc /etc/systemd /etc/systemd/system /etc/lightmoni-executor /etc/lightmoni-executor/config.json /var /var/lib /var/lib/lightmoni-executor /etc/systemd/system/lightmoni-executor.service; do
  [ -e "$item" ] && [ ! -L "$item" ] && [ "$(stat -c %u "$item")" = 0 ] || { echo 'executor_unmanaged_installation' >&2; exit 1; }
  mode=$(stat -c %a "$item")
  [ $((0$mode & 0022)) -eq 0 ] || { echo 'executor_unsafe_installation_permissions' >&2; exit 1; }
done
[ -L /opt/lightmoni-executor/current ] && [ "$(stat -c %u /opt/lightmoni-executor/current)" = 0 ] || { echo 'executor_unmanaged_installation' >&2; exit 1; }
target=$(readlink -f /opt/lightmoni-executor/current)
case "$target" in /opt/lightmoni-executor/releases/*) ;; *) echo 'executor_unmanaged_installation' >&2; exit 1 ;; esac
for item in "$target" "$node"; do
  [ -e "$item" ] && [ ! -L "$item" ] && [ "$(stat -c %u "$item")" = 0 ] || { echo 'executor_unmanaged_installation' >&2; exit 1; }
  mode=$(stat -c %a "$item"); [ $((0$mode & 0022)) -eq 0 ] || { echo 'executor_unmanaged_installation' >&2; exit 1; }
done
safe_status() {
  "$node" -e '
const fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process");
try{const base=fs.realpathSync("/opt/lightmoni-executor/current");for(const file of [base+"/node",base+"/app/runtime/dist/privileged-executor/main.js"]){let d=file;while(true){const s=fs.lstatSync(d);if(s.isSymbolicLink()||s.uid!==0||(s.mode&18))throw Error();if(d==="/")break;d=p.dirname(d);}}const r=cp.spawnSync(base+"/node",[base+"/app/runtime/dist/privileged-executor/main.js","status","--config","/etc/lightmoni-executor/config.json"],{encoding:"utf8",timeout:10000,maxBuffer:65536,env:{PATH:"/usr/bin:/bin"}});if(r.status!==0)throw Error();const s=JSON.parse(r.stdout);if(typeof s.executor_id!=="string"||!s.executor_id||s.fenced!==null||!Number.isSafeInteger(s.pending_results)||s.pending_results!==0)throw Error();const expected=process.argv[1],generation=Number(process.argv[2]);if(expected&&(s.executor_id!==expected||!Number.isSafeInteger(generation)||generation<1||s.install_generation!==generation))throw Error();}catch{process.stderr.write("executor_uninstall_blocked_unresolved_state\n");process.exit(1);}' "$expected_executor_id" "$expected_install_generation"
}
# Only the fixed root entry is managed here. Drop-ins or a changed unit require
# separate review rather than stopping and deleting an unfamiliar service.
for executor_dropin in /etc/systemd/system/lightmoni-executor.service.d /run/systemd/system/lightmoni-executor.service /run/systemd/system/lightmoni-executor.service.d; do
  [ ! -e "$executor_dropin" ] && [ ! -L "$executor_dropin" ] || { echo 'executor_unmanaged_service' >&2; exit 1; }
done
"$node" -e '
const fs=require("node:fs"),path="/etc/systemd/system/lightmoni-executor.service";
try{if(fs.readFileSync(path,"utf8")!==process.argv[1])throw Error();}catch{process.stderr.write("executor_unmanaged_service\n");process.exit(1);}' '[Unit]
Description=LightMoni Privileged Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/local/bin/lightmoni-executor run --config /etc/lightmoni-executor/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=25s
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/etc/lightmoni-executor /var/lib/lightmoni-executor
PrivateTmp=true
LimitCORE=0
TasksMax=512

[Install]
WantedBy=multi-user.target
'
# Re-check after stopping to close the claim-between-check-and-stop race.
executor_fragment=$(systemctl show lightmoni-executor.service --property=FragmentPath --value) || { echo 'executor_unmanaged_service' >&2; exit 1; }
[ "$executor_fragment" = /etc/systemd/system/lightmoni-executor.service ] || { echo 'executor_unmanaged_service' >&2; exit 1; }
executor_dropins=$(systemctl show lightmoni-executor.service --property=DropInPaths --value) || { echo 'executor_unmanaged_service' >&2; exit 1; }
[ -z "$executor_dropins" ] || { echo 'executor_unmanaged_service' >&2; exit 1; }
safe_status
systemctl stop lightmoni-executor.service
executor_stopped_state=$(systemctl show lightmoni-executor.service --property=ActiveState --value) || { echo 'executor_service_not_stopped' >&2; exit 1; }
[ "$executor_stopped_state" = inactive ] || { echo 'executor_service_not_stopped' >&2; exit 1; }
# Standalone writer-lock fragment, checked against executorHostLockShell('writer').
command -v flock >/dev/null 2>&1 || exit 1
for executor_parent in / /var /var/lib /var/lib/lightmoni-executor; do
  [ -d "$executor_parent" ] && [ ! -L "$executor_parent" ] && [ "$(stat -c %u "$executor_parent")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_parent") & 0022)) -eq 0 ] || exit 1
done
[ "$(stat -c %a /var/lib/lightmoni-executor)" = 700 ] || exit 1
executor_lock=/var/lib/lightmoni-executor/writer.lock
if [ -e "$executor_lock" ] || [ -L "$executor_lock" ]; then
  [ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
[ "$(stat -c %a "$executor_lock")" = 600 ] || exit 1
fi
exec 7>>"$executor_lock"
[ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
[ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
[ "$(stat -c %a "$executor_lock")" = 600 ] || exit 1
[ -f /proc/self/fd/7 ] || exit 1
executor_lock_path_identity=$(stat -c '%d:%i:%u:%a' -- "$executor_lock") || exit 1
executor_lock_fd_identity=$(stat -Lc '%d:%i:%u:%a' -- /proc/self/fd/7) || exit 1
[ "$executor_lock_path_identity" = "$executor_lock_fd_identity" ] || exit 1
flock -n 7 || exit 1
safe_status
systemctl disable lightmoni-executor.service >/dev/null
rm -f /etc/systemd/system/lightmoni-executor.service
systemctl daemon-reload
rm -f /usr/local/bin/lightmoni-executor /usr/local/sbin/lightmoni-executor-uninstall
rm -rf /opt/lightmoni-executor /etc/lightmoni-executor /var/lib/lightmoni-executor
echo 'executor_uninstalled=local_only'
echo 'Revoke the executor identity in the platform separately.'
