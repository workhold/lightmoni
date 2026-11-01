/** Shared verbatim with the standalone uninstaller; its contract test prevents drift.
 * These helpers use only Linux core utilities and never execute an installed runtime. */
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
lm_assert_paths() {
  for lm_parent in /run /etc /etc/systemd /etc/systemd/system /usr /usr/local /usr/local/bin /usr/local/sbin /opt /var /var/lib; do
    lm_root_entry "$lm_parent" directory
  done
  lm_root_entry /etc/systemd/system/lightmoni-agent.service file
  lm_root_entry /usr/local/bin/lightmoni-agent file
  lm_root_entry /usr/local/sbin/lightmoni-agent-uninstall file
  lm_root_entry /opt/lightmoni-agent directory
  lm_data_directory /etc/lightmoni-agent
  lm_data_directory /var/lib/lightmoni-agent
  lm_data_directory /var/lib/lightmoni-agent/operations
}
lm_assert_no_operations() {
  if [ -e /var/lib/lightmoni-agent/operations/execution.lock ] || [ -L /var/lib/lightmoni-agent/operations/execution.lock ]; then
    lm_refuse 'Agent has an unfinished operation'
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
