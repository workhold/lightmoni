#!/bin/sh
# Fixed root-owned updater. The caller approves and verifies the archive SHA256.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin;export PATH
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || exit 1
release_dir='';artifact='';action='';expected_id='';expected_generation='';expected_current=''
while [ "$#" -gt 0 ]; do
 [ "$#" -ge 2 ] || exit 2
 case "$1" in
 --release-dir) release_dir="$2";; --artifact-sha256) artifact="$2";; --action) action="$2";;
 --expected-executor-id) expected_id="$2";; --expected-install-generation) expected_generation="$2";; --expected-current-sha) expected_current="$2";; *) exit 2;; esac
 shift 2
done
case "$release_dir" in /*) ;; *) exit 2;; esac
case "$artifact:$expected_current" in *[!a-f0-9:]*) exit 2;; esac
[ "${#artifact}" -eq 64 ] && [ "${#expected_current}" -eq 64 ] || exit 2
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

# Validate the interpreter and every ancestor before loading the checked bundle.
checked="$release_dir/node"
while :; do
 [ -e "$checked" ] && [ ! -L "$checked" ] && [ "$(stat -c %u "$checked")" = 0 ] || exit 1
 [ $((0$(stat -c %a "$checked") & 0022)) -eq 0 ] || exit 1
 [ "$checked" = / ] && break
 checked=$(dirname -- "$checked")
done
printf '{"schema":1,"artifact_sha256":"%s"}\n' "$artifact" > "$release_dir/installation.json"
chmod 0644 "$release_dir/installation.json"
LIGHTMONI_EXECUTOR_UPGRADE_LOCK=held;export LIGHTMONI_EXECUTOR_UPGRADE_LOCK
exec "$release_dir/node" "$release_dir/app/runtime/dist/privileged-executor/main.js" upgrade --action "$action" --expected-executor-id "$expected_id" --expected-install-generation "$expected_generation" --expected-current-sha "$expected_current" --target-sha "$artifact"
