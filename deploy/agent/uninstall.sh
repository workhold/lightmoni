#!/bin/sh
set -eu
purge="false"
case "$#:${1:-}" in
  0:) ;;
  1:--purge) purge="true" ;;
  1:--help) echo 'Usage: lightmoni-agent-uninstall [--purge]'; exit 0 ;;
  *) echo 'Usage: lightmoni-agent-uninstall [--purge]' >&2; exit 1 ;;
esac
[ "$(id -u)" = "0" ] || { echo 'Run as root.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }
command -v stat >/dev/null || { echo 'stat is required.' >&2; exit 1; }
umask 077
# BEGIN SHARED MAINTENANCE GUARDS
lm_refuse() {
  echo "$1; Agent files retained." >&2
  exit 1
}
lm_root_entry() {
  lm_path="$1"
  lm_kind="$2"
  [ ! -L "$lm_path" ] || lm_refuse 'Unsafe Agent path (symbolic link)'
  if [ ! -e "$lm_path" ]; then return; fi
  if [ "$lm_kind" = directory ]; then
    [ -d "$lm_path" ] || lm_refuse 'Unsafe Agent directory'
  else
    [ -f "$lm_path" ] || lm_refuse 'Unsafe Agent program file'
  fi
  stat -c '%u:%a' -- "$lm_path" 2>/dev/null | LC_ALL=C awk -F: '
    BEGIN { safe = 0 }
    $1 == "0" && $2 ~ /^([0-7])?[0-7][0145][0145]$/ { safe = 1 }
    END { exit !safe }
  ' || lm_refuse 'Agent program path must be root owned and not writable by other users'
}
lm_data_directory() {
  [ ! -L "$1" ] || lm_refuse 'Unsafe Agent data directory (symbolic link)'
  if [ -e "$1" ]; then
    [ -d "$1" ] || lm_refuse 'Unsafe Agent data directory'
  fi
}
lm_assert_paths() {
  if [ -e /usr/local/bin/lightmoni-executor ] || [ -L /usr/local/bin/lightmoni-executor ] || [ -e /usr/local/sbin/lightmoni-executor-uninstall ] || [ -L /usr/local/sbin/lightmoni-executor-uninstall ] || [ -e /opt/lightmoni-executor ] || [ -L /opt/lightmoni-executor ] || [ -e /etc/lightmoni-executor ] || [ -L /etc/lightmoni-executor ] || [ -e /var/lib/lightmoni-executor ] || [ -L /var/lib/lightmoni-executor ] || [ -e /etc/systemd/system/lightmoni-executor.service ] || [ -L /etc/systemd/system/lightmoni-executor.service ] || [ -e /etc/systemd/system/lightmoni-executor.service.d ] || [ -L /etc/systemd/system/lightmoni-executor.service.d ]; then
    lm_refuse 'Legacy standalone lightmoni-executor layout detected; use its original-version uninstaller before managing the unified Agent.'
  fi
  if [ -e /etc/lightmoni-agent/managed.json ] || [ -L /etc/lightmoni-agent/managed.json ] || [ -e /var/lib/lightmoni-agent/managed ] || [ -L /var/lib/lightmoni-agent/managed ]; then
    lm_refuse 'Unsupported Agent layout requires explicit recovery'
  fi
  for lm_parent in /run /etc /etc/systemd /etc/systemd/system /usr /usr/local /usr/local/bin /usr/local/sbin /opt /var /var/lib; do
    lm_root_entry "$lm_parent" directory
  done
  lm_root_entry /etc/systemd/system/lightmoni-agent.service file
  lm_root_entry /etc/systemd/system/lightmoni-agent-helper.service file
  lm_root_entry /etc/lightmoni-agent-helper directory
  lm_root_entry /etc/lightmoni-agent-helper/helper.json file
  lm_root_entry /etc/lightmoni-agent-helper/managed.json file
  lm_root_entry /etc/lightmoni-agent-helper/managed-activation.json file
  lm_root_entry /var/lib/lightmoni-agent-helper directory
  lm_root_entry /var/lib/lightmoni-agent-helper/managed directory
  lm_root_entry /var/lib/lightmoni-agent-helper/tasks directory
  lm_root_entry /var/lib/lightmoni-agent-task-account.json file
  lm_root_entry /usr/local/bin/lightmoni-agent file
  lm_root_entry /usr/local/sbin/lightmoni-agent-uninstall file
  lm_root_entry /opt/lightmoni-agent directory
  lm_data_directory /etc/lightmoni-agent
  lm_data_directory /var/lib/lightmoni-agent
  lm_data_directory /var/lib/lightmoni-agent/operations
  lm_data_directory /etc/lightmoni-agent-helper
  lm_data_directory /var/lib/lightmoni-agent-helper
  lm_data_directory /var/lib/lightmoni-agent-helper/managed
  lm_data_directory /var/lib/lightmoni-agent-helper/tasks
}
lm_assert_no_operations() {
  lm_assert_task_account
  if [ -d /var/lib/lightmoni-agent-helper/tasks ] && [ -n "$(find /var/lib/lightmoni-agent-helper/tasks -mindepth 1 -maxdepth 1 -print -quit)" ] && [ ! -f /etc/lightmoni-agent-helper/managed.json ]; then
    lm_refuse 'Agent task journal requires recovery before removal'
  fi
  if [ -e /var/lib/lightmoni-agent/operations/execution.lock ] || [ -L /var/lib/lightmoni-agent/operations/execution.lock ]; then
    lm_refuse 'Agent has an unfinished operation'
  fi
  if [ -e /etc/lightmoni-agent-helper/managed.json ] || [ -L /etc/lightmoni-agent-helper/managed.json ] || [ -e /var/lib/lightmoni-agent-helper/managed ] || [ -L /var/lib/lightmoni-agent-helper/managed ]; then
    lm_root_entry /etc/lightmoni-agent-helper directory
    lm_root_entry /etc/lightmoni-agent-helper/managed.json file
    lm_root_entry /var/lib/lightmoni-agent-helper directory
    lm_root_entry /var/lib/lightmoni-agent-helper/managed directory
    lm_root_entry /usr/local/bin/lightmoni-agent file
    [ -f /etc/lightmoni-agent-helper/managed.json ] && [ -x /usr/local/bin/lightmoni-agent ] || lm_refuse 'Managed Agent state requires recovery before removal'
    lm_managed=$(/usr/local/bin/lightmoni-agent helper-status) || lm_refuse 'Managed Agent journal cannot be verified'
    printf '%s' "$lm_managed" | LC_ALL=C grep -Eq '"fenced"[[:space:]]*:[[:space:]]*null' || lm_refuse 'Managed Agent has an unfinished operation'
    printf '%s' "$lm_managed" | LC_ALL=C grep -Eq '"pending_results"[[:space:]]*:[[:space:]]*0([,}[:space:]])' || lm_refuse 'Managed Agent has unreported results'
    printf '%s' "$lm_managed" | LC_ALL=C grep -Eq '"ordinary_task_runner"[[:space:]]*:[[:space:]]*\{[^}]*"active"[[:space:]]*:[[:space:]]*false[^}]*"state"[[:space:]]*:[[:space:]]*"idle"' || lm_refuse 'Agent task runner is not idle'
  fi
  for lm_marker in /var/lib/lightmoni-agent/agent-job-state.json /var/lib/lightmoni-agent/task-run-state.json; do
    [ ! -L "$lm_marker" ] || lm_refuse 'Agent has an unsafe unfinished operation marker'
    if [ -e "$lm_marker" ]; then
      [ -f "$lm_marker" ] && [ -r "$lm_marker" ] || lm_refuse 'Agent has an unreadable unfinished operation marker'
      lm_size=$(wc -c < "$lm_marker") || lm_refuse 'Agent operation marker cannot be inspected'
      [ "$lm_size" -le 65536 ] || lm_refuse 'Agent operation marker is too large'
      # Some awk implementations truncate at NUL. Reject binary corruption
      # before interpreting a marker as an empty JSON object.
      lm_text_size=$(LC_ALL=C tr -d '\000' < "$lm_marker" | wc -c)
      [ "$lm_text_size" -eq "$lm_size" ] || lm_refuse 'Agent operation marker contains invalid bytes'
      # Runners clear state by writing {}. Also accept the explicit empty-id
      # form. All other contents, including invalid JSON, remain a barrier.
      LC_ALL=C awk '
        { value = value $0 "\n" }
        END { exit !(value ~ /^[ \t\r\n]*\{[ \t\r\n]*("id"[ \t\r\n]*:[ \t\r\n]*""[ \t\r\n]*)?\}[ \t\r\n]*$/) }
      ' "$lm_marker" || lm_refuse 'Agent has an unfinished operation or invalid operation marker'
    fi
  done
}
lm_remove_managed_state() {
  # Only after the stopped-service and journal checks, before deleting code.
  rm -rf /etc/lightmoni-agent-helper /var/lib/lightmoni-agent-helper
}
lm_assert_task_account() {
  marker=/var/lib/lightmoni-agent-task-account.json
  [ -e "$marker" ] || { if id lightmoni-task >/dev/null 2>&1; then lm_refuse 'Unmanaged lightmoni-task account'; fi; return 0; }
  [ -f "$marker" ] && [ ! -L "$marker" ] || lm_refuse 'Invalid task account marker'
  task_uid=$(id -u lightmoni-task 2>/dev/null) || lm_refuse 'Marked task account is missing'
  task_gid=$(id -g lightmoni-task 2>/dev/null) || lm_refuse 'Marked task group is missing'
  recorded_uid=$(LC_ALL=C sed -n 's/.*"uid":\([0-9][0-9]*\).*/\1/p' "$marker")
  recorded_gid=$(LC_ALL=C sed -n 's/.*"gid":\([0-9][0-9]*\).*/\1/p' "$marker")
  case "$recorded_uid:$recorded_gid" in *[!0-9:]*|:*) lm_refuse 'Invalid task account marker';; esac
  [ "$task_uid" = "$recorded_uid" ] && [ "$task_gid" = "$recorded_gid" ] || lm_refuse 'Task account identity changed'
  [ "$(id -Gn lightmoni-task | tr ' ' '\n' | wc -l | tr -d ' ')" = 1 ] || lm_refuse 'Task account has unexpected supplementary groups'
  task_group=$(getent group lightmoni-task) || lm_refuse 'Task group cannot be verified'
  group_record=$(printf '%s\n' "$task_group" | awk -F: 'NF == 4 && $1 == "lightmoni-task" { print $1 ":" $3 ":" $4 }')
  [ "$group_record" = "lightmoni-task:$recorded_gid:" ] || lm_refuse 'Task group is shared or its identity changed'
}
lm_remove_task_account() {
  lm_assert_task_account
  [ -e /var/lib/lightmoni-agent-task-account.json ] || return 0
  userdel lightmoni-task
  groupdel lightmoni-task
  rm -f /var/lib/lightmoni-agent-task-account.json
}
lm_purge_agent_state() {
  lm_assert_paths
  lm_assert_no_operations
  rm -rf /etc/lightmoni-agent
  if [ -d /var/lib/lightmoni-agent ]; then
    # Operations contain persistent application data and configuration, not Agent identity.
    find /var/lib/lightmoni-agent -mindepth 1 -maxdepth 1 ! -name operations -exec rm -rf -- {} +
    if [ -d /var/lib/lightmoni-agent/operations ]; then rmdir /var/lib/lightmoni-agent/operations 2>/dev/null || :; fi
    rmdir /var/lib/lightmoni-agent 2>/dev/null || :
  fi
}
# END SHARED MAINTENANCE GUARDS
lm_assert_paths
lock=/run/lightmoni-agent-lifecycle.lock
mkdir "$lock" || { echo 'Agent lifecycle operation already in progress.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
lm_assert_no_operations
# Systemd query failures cannot establish that a service is absent.
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
if [ "$load_state" != "not-found" ]; then
  [ "$load_state" = loaded ] && [ "$fragment" = /etc/systemd/system/lightmoni-agent.service ] || lm_refuse 'Non-managed Agent unit'
  systemctl stop lightmoni-agent.service
  state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
  case "$state" in inactive|failed) ;; *) lm_refuse 'Agent did not stop';; esac
else
  [ -z "$fragment" ] || lm_refuse 'Non-managed Agent unit'
  state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
  case "$state" in inactive|failed) ;; *) lm_refuse 'Agent state is uncertain';; esac
fi
helper_load_state=$(systemctl show lightmoni-agent-helper.service --property=LoadState --value)
helper_fragment=$(systemctl show lightmoni-agent-helper.service --property=FragmentPath --value)
if [ "$helper_load_state" != "not-found" ]; then
  [ "$helper_load_state" = loaded ] && [ "$helper_fragment" = /etc/systemd/system/lightmoni-agent-helper.service ] || lm_refuse 'Non-managed Agent helper unit'
  systemctl stop lightmoni-agent-helper.service
  helper_state=$(systemctl show lightmoni-agent-helper.service --property=ActiveState --value)
  case "$helper_state" in inactive|failed) ;; *) lm_refuse 'Agent helper did not stop';; esac
else
  [ -z "$helper_fragment" ] || lm_refuse 'Non-managed Agent helper unit'
  helper_state=$(systemctl show lightmoni-agent-helper.service --property=ActiveState --value)
  case "$helper_state" in inactive|failed) ;; *) lm_refuse 'Agent helper state is uncertain';; esac
fi
# Stop can race a previously claimed job persisting its recovery marker.
# Recheck before disabling or removing any program or retained evidence.
lm_assert_paths
lm_assert_no_operations
lm_remove_task_account
lm_remove_managed_state
if [ "$load_state" = loaded ]; then systemctl disable lightmoni-agent.service; fi
if [ "$helper_load_state" = loaded ]; then systemctl disable lightmoni-agent-helper.service; fi
rm -f /etc/systemd/system/lightmoni-agent.service /etc/systemd/system/lightmoni-agent-helper.service /usr/local/bin/lightmoni-agent /usr/local/sbin/lightmoni-agent-uninstall
rm -rf /opt/lightmoni-agent
systemctl daemon-reload
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
[ "$load_state" = not-found ] || { echo 'Agent unit still exists; inspect locally.' >&2; exit 1; }
helper_load_state=$(systemctl show lightmoni-agent-helper.service --property=LoadState --value)
[ "$helper_load_state" = not-found ] || { echo 'Agent helper unit still exists; inspect locally.' >&2; exit 1; }
if [ "$purge" = "true" ]; then
  lm_purge_agent_state
  echo 'LightMoni Agent removed; identity, configuration and cached telemetry deleted by explicit --purge; application operations and persistent data retained.'
else
  echo 'LightMoni Agent removed; configuration, identity and cached telemetry retained.'
fi
echo 'This local script does not revoke platform credentials or delete the registered host.'
