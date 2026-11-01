/** Fixed local lifecycle fences shared by SSH installation and absence probes.
 * Callers supply neither paths nor shell fragments. Each workflow keeps its own
 * lock and descriptor, and the lock is never a source of execution authority. */
export function executorHostLockShell(kind: "bootstrap" | "lifecycle" | "writer"): string {
  if (kind !== "bootstrap" && kind !== "lifecycle" && kind !== "writer") throw Error("invalid_executor_host_lock");
  const descriptor = kind === "bootstrap" ? 8 : kind === "lifecycle" ? 9 : 7;
  const parents = kind === "writer" ? "/ /var /var/lib /var/lib/lightmoni-executor" : "/ /run";
  const lock = kind === "writer" ? "/var/lib/lightmoni-executor/writer.lock" : `/run/lightmoni-executor-${kind}.lock`;
  const privateParent = kind === "writer" ? '[ "$(stat -c %a /var/lib/lightmoni-executor)" = 700 ] || exit 1\n' : "";
  const privateLock = kind === "writer" ? '[ "$(stat -c %a "$executor_lock")" = 600 ] || exit 1\n' : "";
  return `command -v flock >/dev/null 2>&1 || exit 1
for executor_parent in ${parents}; do
  [ -d "$executor_parent" ] && [ ! -L "$executor_parent" ] && [ "$(stat -c %u "$executor_parent")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_parent") & 0022)) -eq 0 ] || exit 1
done
${privateParent}executor_lock=${lock}
if [ -e "$executor_lock" ] || [ -L "$executor_lock" ]; then
  [ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
${privateLock}fi
exec ${descriptor}>>"$executor_lock"
[ -f "$executor_lock" ] && [ ! -L "$executor_lock" ] && [ "$(stat -c %u "$executor_lock")" = 0 ] || exit 1
[ $((0$(stat -c %a "$executor_lock") & 0022)) -eq 0 ] || exit 1
${privateLock}[ -f /proc/self/fd/${descriptor} ] || exit 1
executor_lock_path_identity=$(stat -c '%d:%i:%u:%a' -- "$executor_lock") || exit 1
executor_lock_fd_identity=$(stat -Lc '%d:%i:%u:%a' -- /proc/self/fd/${descriptor}) || exit 1
[ "$executor_lock_path_identity" = "$executor_lock_fd_identity" ] || exit 1
flock -n ${descriptor} || exit 1`;
}

/** The complete fixed absence evidence. A missing leaf is meaningful only
 * beneath validated ancestors and with both successful systemd queries. The
 * caller must already hold its workflow's host lock and establish root + PATH. */
export const executorAbsenceProofShell = `for parent in / /opt /etc /var /var/lib /usr /usr/local /usr/local/bin /etc/systemd /etc/systemd/system /run/systemd /run/systemd/system; do
  [ -d "$parent" ] && [ ! -L "$parent" ] && [ "$(stat -c %u "$parent")" = 0 ] || exit 1
  [ $((0$(stat -c %a "$parent") & 0022)) -eq 0 ] || exit 1
done
if [ -e /usr/local/sbin ] || [ -L /usr/local/sbin ]; then
  [ -d /usr/local/sbin ] && [ ! -L /usr/local/sbin ] && [ "$(stat -c %u /usr/local/sbin)" = 0 ] || exit 1
  [ $((0$(stat -c %a /usr/local/sbin) & 0022)) -eq 0 ] || exit 1
fi
for p in /opt/lightmoni-executor /etc/lightmoni-executor /var/lib/lightmoni-executor /usr/local/bin/lightmoni-executor /usr/local/sbin/lightmoni-executor-uninstall /etc/systemd/system/lightmoni-executor.service /etc/systemd/system/lightmoni-executor.service.d /run/systemd/system/lightmoni-executor.service /run/systemd/system/lightmoni-executor.service.d; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || exit 1
done
command -v systemctl >/dev/null 2>&1 || exit 1
load_state=$(systemctl show lightmoni-executor.service --property=LoadState --value) || exit 1
[ "$load_state" = not-found ] || exit 1
active_state=$(systemctl show lightmoni-executor.service --property=ActiveState --value) || exit 1
[ "$active_state" = inactive ] || exit 1`;
