#!/bin/sh
# The caller verifies the approved archive digest before extraction. This helper
# consumes its one-use bootstrap JSON directly from stdin; it never stores it.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
[ "$(id -u)" = 0 ] || { echo 'executor_install_requires_root' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'executor_install_requires_linux' >&2; exit 1; }
release_dir=''
artifact_sha256=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir) [ "$#" -ge 2 ] || exit 2; release_dir="$2"; shift 2 ;;
    --artifact-sha256) [ "$#" -ge 2 ] || exit 2; artifact_sha256="$2"; shift 2 ;;
    *) echo 'executor_install_invalid_argument' >&2; exit 2 ;;
  esac
done
case "$release_dir" in /*) ;; *) echo 'executor_install_requires_absolute_release' >&2; exit 2 ;; esac
case "$artifact_sha256" in *[!a-f0-9]*|'') echo 'executor_install_invalid_digest' >&2; exit 2 ;; esac
[ "${#artifact_sha256}" -eq 64 ] || { echo 'executor_install_invalid_digest' >&2; exit 2; }
for command in systemctl systemd-run install cp mv chmod flock; do command -v "$command" >/dev/null 2>&1 || { echo 'executor_install_dependency_unavailable' >&2; exit 1; }; done
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
[ ! -e /etc/lightmoni-executor/config.json ] && [ ! -L /etc/lightmoni-executor/config.json ] && [ ! -e /var/lib/lightmoni-executor/journal.sqlite ] && [ ! -e /opt/lightmoni-executor ] && [ ! -L /opt/lightmoni-executor ] && [ ! -e /usr/local/bin/lightmoni-executor ] && [ ! -L /usr/local/bin/lightmoni-executor ] && [ ! -e /etc/systemd/system/lightmoni-executor.service ] || { echo 'executor_existing_installation_requires_reviewed_maintenance' >&2; exit 1; }
for executor_unit_path in /etc/systemd/system/lightmoni-executor.service /etc/systemd/system/lightmoni-executor.service.d /run/systemd/system/lightmoni-executor.service /run/systemd/system/lightmoni-executor.service.d; do
  [ ! -e "$executor_unit_path" ] && [ ! -L "$executor_unit_path" ] || { echo 'executor_existing_installation_requires_reviewed_maintenance' >&2; exit 1; }
done
node="$release_dir/node"
check_path() {
  checked="$1"
  while :; do
    [ ! -L "$checked" ] && [ -e "$checked" ] || { echo 'executor_unsafe_release' >&2; exit 1; }
    [ "$(stat -c %u "$checked")" = 0 ] || { echo 'executor_unsafe_release_owner' >&2; exit 1; }
    mode=$(stat -c %a "$checked")
    case "$checked:$mode" in /tmp:1777|/var/tmp:1777) ;; *)
      [ $((0$mode & 0022)) -eq 0 ] || { echo 'executor_unsafe_release_permissions' >&2; exit 1; } ;;
    esac
    [ "$checked" = / ] && break
    checked=$(dirname -- "$checked")
  done
}
check_path "$node"
for parent in /opt /etc /etc/systemd /etc/systemd/system /var /var/lib /usr /usr/local /usr/local/bin /run; do check_path "$parent"; done
for runtime_unit_parent in /run/systemd /run/systemd/system; do
  if [ -e "$runtime_unit_parent" ] || [ -L "$runtime_unit_parent" ]; then check_path "$runtime_unit_parent"; fi
done
for existing in /etc/lightmoni-executor /var/lib/lightmoni-executor /usr/local/sbin; do
  if [ -e "$existing" ] || [ -L "$existing" ]; then check_path "$existing"; fi
done
[ -x "$node" ] || { echo 'executor_runtime_missing' >&2; exit 1; }
"$node" -e '
const fs=require("node:fs"),p=require("node:path");
const base=process.argv[1];
if(p.resolve(base)!==base)process.exit(1);
function walk(file){const s=fs.lstatSync(file);if(s.uid!==0)throw Error();if(s.isSymbolicLink()){const real=fs.realpathSync(file);if(!real.startsWith(base+"/"))throw Error();return;}if(s.mode&18)throw Error();if(s.isDirectory()){for(const name of fs.readdirSync(file))walk(p.join(file,name));}else if(!s.isFile())throw Error();}
try{walk(base);for(const f of ["app/runtime/dist/privileged-executor/main.js","executor/launcher.sh","executor/lightmoni-executor.service","executor/uninstall.sh"]){if(!fs.statSync(p.join(base,f)).isFile())throw Error();}const m=JSON.parse(fs.readFileSync(p.join(base,"release.json"),"utf8"));if(m.state_schema!==1||!/^[-A-Za-z0-9._]{1,128}$/.test(m.build_id||"")||!/^[-A-Za-z0-9._]{1,128}$/.test(m.version||""))throw Error();}catch{process.stderr.write("executor_invalid_release\n");process.exit(1);}' "$release_dir"
phase=prepare
completed=no
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$completed" != yes ]; then
    systemctl stop lightmoni-executor.service >/dev/null 2>&1 || true
    systemctl disable lightmoni-executor.service >/dev/null 2>&1 || true
    # Preserve identity, program and journal when a response may have been lost.
    echo "executor_installation_unknown:$phase" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
install -d -m 0700 -o root -g root /opt/lightmoni-executor /opt/lightmoni-executor/releases /etc/lightmoni-executor /var/lib/lightmoni-executor
release_name=$("$node" -e 'const m=require(process.argv[1]+"/release.json");process.stdout.write(m.build_id)' "$release_dir")
target="/opt/lightmoni-executor/releases/$release_name"
[ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'executor_release_already_exists' >&2; exit 1; }
cp -R "$release_dir" "$target"
chmod -R u=rwX,go=rX "$target"
printf '{"schema":1,"artifact_sha256":"%s"}\n' "$artifact_sha256" > "$target/installation.json"
chmod 0644 "$target/installation.json"
ln -s "$target" /opt/lightmoni-executor/current
install -m 0755 -o root -g root "$target/executor/launcher.sh" /usr/local/bin/lightmoni-executor
install -d -m 0755 -o root -g root /usr/local/sbin
install -m 0755 -o root -g root "$target/executor/uninstall.sh" /usr/local/sbin/lightmoni-executor-uninstall
phase=enrollment
# No command line, environment variable or temporary file receives the token.
if ! /usr/local/bin/lightmoni-executor enroll --config /etc/lightmoni-executor/config.json >/dev/null 2>&1; then
  echo 'executor_enrollment_failed_or_unknown' >&2
  exit 1
fi
phase=configuration_check
/usr/local/bin/lightmoni-executor check --config /etc/lightmoni-executor/config.json >/dev/null 2>&1 || { echo 'executor_configuration_invalid' >&2; exit 1; }
phase=service_start
install -m 0644 -o root -g root "$target/executor/lightmoni-executor.service" /etc/systemd/system/lightmoni-executor.service
systemctl daemon-reload
systemctl enable lightmoni-executor.service >/dev/null
systemctl restart lightmoni-executor.service
count=0
active_count=0
while [ "$count" -lt 10 ]; do
  if systemctl is-active --quiet lightmoni-executor.service; then
    active_count=$((active_count + 1))
    if [ "$active_count" -ge 3 ]; then
      phase=ready
      completed=yes
      echo 'executor_installation=ready'
      exit 0
    fi
  else
    active_count=0
  fi
  count=$((count + 1))
  sleep 1
done
echo 'executor_service_not_active' >&2
exit 1
