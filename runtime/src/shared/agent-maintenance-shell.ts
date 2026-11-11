export const agentServiceDropinPaths = [
  "/etc/systemd/system/lightmoni-agent.service.d",
  "/etc/systemd/system/lightmoni-agent-helper.service.d",
] as const;

/** Fixed footprint shared by SSH discovery and fresh-deployment guards. */
export const agentInstallationPaths = [
  "/usr/local/bin/lightmoni-agent", "/opt/lightmoni-agent",
  "/etc/systemd/system/lightmoni-agent.service", "/etc/lightmoni-agent/config.json",
  "/var/lib/lightmoni-agent/identity.json", "/etc/systemd/system/lightmoni-agent-helper.service",
  "/etc/lightmoni-agent-helper", "/var/lib/lightmoni-agent-helper",
  ...agentServiceDropinPaths,
] as const;
export const agentInstallationPresentShell = agentInstallationPaths.map(filename => `test -e ${filename} || test -L ${filename}`).join(" || ");

/** Shared verbatim with the standalone uninstaller; its contract test prevents drift.
 * Managed journal inspection uses the root entry, which verifies its program tree. */
export const agentMaintenanceShellGuards = String.raw`lm_refuse() {
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
lm_assert_dropins() {
  lm_dropin_directory="$1"
  lm_root_entry "$lm_dropin_directory" directory
  [ -d "$lm_dropin_directory" ] || return 0
  lm_dropin_count=0
  for lm_dropin_entry in "$lm_dropin_directory"/* "$lm_dropin_directory"/.[!.]* "$lm_dropin_directory"/..?*; do
    if [ ! -e "$lm_dropin_entry" ] && [ ! -L "$lm_dropin_entry" ]; then continue; fi
    lm_dropin_count=$((lm_dropin_count + 1))
    [ "$lm_dropin_count" -le 128 ] || lm_refuse 'Too many Agent service overrides'
    lm_root_entry "$lm_dropin_entry" file
    lm_dropin_size=$(wc -c < "$lm_dropin_entry") || lm_refuse 'Agent service override cannot be inspected'
    [ "$lm_dropin_size" -le 65536 ] || lm_refuse 'Agent service override is too large'
  done
}
lm_dropin_evidence() {
  lm_digest_directory="$1"
  lm_assert_dropins "$lm_digest_directory"
  if [ ! -d "$lm_digest_directory" ]; then printf 'absent\n'; return; fi
  stat -c '%u:%a:%d:%i:%Y' -- "$lm_digest_directory" || return 1
  for lm_digest_entry in "$lm_digest_directory"/* "$lm_digest_directory"/.[!.]* "$lm_digest_directory"/..?*; do
    if [ ! -e "$lm_digest_entry" ] && [ ! -L "$lm_digest_entry" ]; then continue; fi
    stat -c '%u:%a:%d:%i:%Y' -- "$lm_digest_entry" || return 1
    sha256sum -- "$lm_digest_entry" || return 1
  done
}
lm_remove_service_dropins() {
  lm_assert_paths
  # Only fixed, validated flat service directories; never follow links.
  rm -rf -- /etc/systemd/system/lightmoni-agent.service.d /etc/systemd/system/lightmoni-agent-helper.service.d
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
  lm_assert_dropins /etc/systemd/system/lightmoni-agent.service.d
  lm_assert_dropins /etc/systemd/system/lightmoni-agent-helper.service.d
  lm_root_entry /etc/lightmoni-agent-helper directory
  lm_root_entry /etc/lightmoni-agent-helper/helper.json file
  lm_root_entry /etc/lightmoni-agent-helper/managed.json file
  lm_root_entry /etc/lightmoni-agent-helper/managed-activation.json file
  lm_root_entry /var/lib/lightmoni-agent-helper directory
  lm_root_entry /var/lib/lightmoni-agent-helper/managed directory
  lm_root_entry /var/lib/lightmoni-agent-helper/tasks directory
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
  for lm_marker in /var/lib/lightmoni-agent/agent-job-state.json /var/lib/lightmoni-agent/task-run-state.json /var/lib/lightmoni-agent-helper/managed/task-run-state.json /var/lib/lightmoni-agent-helper/managed/task-run-ssh-state.json; do
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
}`;
