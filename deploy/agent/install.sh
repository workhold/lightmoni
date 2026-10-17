#!/bin/sh
set -eu

version="0.1.0"
release_url=""
release_dir=""
config_source=""
endpoint=""
group_id=""
key_stdin=""
reporting_key=""

usage() {
  echo 'Usage: install.sh (--release-url URL --key-stdin | --release-dir DIR) [--version VERSION] [--config FILE | --endpoint URL --key-stdin] [--group-id GROUP]'
  echo 'The reporting configuration is generated automatically. Existing identity and cached data are preserved.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --release-url) release_url="$2"; shift 2 ;;
    --release-dir) release_dir="$2"; shift 2 ;;
    --config) config_source="$2"; shift 2 ;;
    --endpoint) endpoint="$2"; shift 2 ;;
    --group-id) group_id="$2"; shift 2 ;;
    --key-stdin) key_stdin="yes"; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo 'Run as root to install the system service.' >&2; exit 1; }
[ "$(uname -s)" = "Linux" ] || { echo 'This installer supports Linux.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required.' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch="amd64" ;; aarch64|arm64) arch="arm64" ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
case "$version" in *[!0-9A-Za-z._-]*|'') echo 'Invalid fixed version.' >&2; exit 1 ;; esac
[ -n "$release_dir" ] || [ -n "$release_url" ] || { usage >&2; exit 1; }

config_path="/etc/lightmoni-agent/config.json"
if [ ! -f "$config_path" ] && [ -z "$config_source" ] && [ -z "$endpoint" ]; then
  echo 'First installation requires a reporting address and key; generate the command in LightMoni.' >&2
  exit 1
fi
if [ -n "$endpoint" ] && [ "$key_stdin" != "yes" ]; then echo 'A reporting address requires --key-stdin.' >&2; exit 1; fi
if [ -n "$config_source" ]; then [ -f "$config_source" ] || { echo 'Configuration file missing.' >&2; exit 1; }; fi

tmp_dir="$(mktemp -d)"
transaction_started="no"
service_changed="no"
restart_attempted="no"
enable_attempted="no"
previous_active="no"
previous_enabled="no"
runtime_release=""
rollback_failed="no"
restore_file() {
  destination="$1"
  snapshot="$2"
  if [ -e "$snapshot" ] || [ -L "$snapshot" ]; then
    cp -Pp "$snapshot" "$destination.restore-$$" && mv -Tf "$destination.restore-$$" "$destination" || rollback_failed="yes"
  else
    rm -f "$destination" || rollback_failed="yes"
  fi
}
finish() {
  result="$1"
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ] && [ "$transaction_started" = "yes" ]; then
    echo 'Installation failed; restoring the previous Agent installation and configuration.' >&2
    if [ "$restart_attempted" = "yes" ]; then systemctl stop lightmoni-agent.service || rollback_failed="yes"; fi
    restore_file /etc/lightmoni-agent/config.json "$tmp_dir/previous-config"
    restore_file /usr/local/bin/lightmoni-agent "$tmp_dir/previous-launcher"
    restore_file /etc/systemd/system/lightmoni-agent.service "$tmp_dir/previous-service"
    restore_file /opt/lightmoni-agent/current "$tmp_dir/previous-current"
    if [ "$service_changed" = "yes" ]; then systemctl daemon-reload || rollback_failed="yes"; fi
    if [ "$enable_attempted" = "yes" ]; then
      if [ "$previous_enabled" = "yes" ]; then systemctl enable lightmoni-agent.service || rollback_failed="yes"
      else systemctl disable lightmoni-agent.service || rollback_failed="yes"; fi
    fi
    if [ "$restart_attempted" = "yes" ] && [ "$previous_active" = "yes" ]; then
      systemctl restart lightmoni-agent.service || rollback_failed="yes"
      systemctl is-active --quiet lightmoni-agent.service || rollback_failed="yes"
    fi
    rm -f "/opt/lightmoni-agent/.current-$$" "/usr/local/bin/.lightmoni-agent.new-$$" "/etc/lightmoni-agent/.config.new-$$"
    if [ "$rollback_failed" = "no" ] && [ -n "$runtime_release" ]; then rm -rf "$runtime_release"; fi
  fi
  if [ "$rollback_failed" = "yes" ]; then
    echo "Automatic restoration needs attention; previous files remain in $tmp_dir" >&2
  else
    rm -rf "$tmp_dir"
  fi
  exit "$result"
}
trap 'finish "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$key_stdin" = "yes" ]; then
  IFS= read -r reporting_key || :
  [ -n "$reporting_key" ] || { echo 'A reporting key is required.' >&2; exit 1; }
fi
if [ -z "$release_dir" ] && [ -z "$reporting_key" ]; then
  echo 'Online installation requires --key-stdin to authenticate LightMoni Agent downloads.' >&2
  exit 1
fi
artifact="lightmoni-agent_${version}_linux_${arch}.tar.gz"
if [ -n "$release_dir" ]; then
  cp "$release_dir/$artifact" "$tmp_dir/$artifact"
  cp "$release_dir/SHA256SUMS" "$tmp_dir/SHA256SUMS"
else
  command -v curl >/dev/null || { echo 'curl is required for online installation.' >&2; exit 1; }
  curl --fail --silent --show-error --location --header "Authorization: Bearer $reporting_key" "$release_url/$artifact" --output "$tmp_dir/$artifact"
  curl --fail --silent --show-error --location --header "Authorization: Bearer $reporting_key" "$release_url/SHA256SUMS" --output "$tmp_dir/SHA256SUMS"
fi
expected="$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$tmp_dir/SHA256SUMS")"
[ "${#expected}" = "64" ] || { echo 'Release checksum missing or ambiguous.' >&2; exit 1; }
actual="$(sha256sum "$tmp_dir/$artifact" | awk '{ print $1 }')"
[ "$expected" = "$actual" ] || { echo 'Release checksum verification failed.' >&2; exit 1; }
mkdir "$tmp_dir/unpacked"
tar -xzf "$tmp_dir/$artifact" -C "$tmp_dir/unpacked" lightmoni-agent lightmoni-agent.service lightmoni-agent-runtime
[ -f "$tmp_dir/unpacked/lightmoni-agent" ] && [ ! -L "$tmp_dir/unpacked/lightmoni-agent" ] || { echo 'Invalid release binary.' >&2; exit 1; }
[ -x "$tmp_dir/unpacked/lightmoni-agent-runtime/node" ] || { echo 'Bundled Node runtime is missing.' >&2; exit 1; }
"$tmp_dir/unpacked/lightmoni-agent-runtime/node" --version >/dev/null || { echo 'The release requires Linux with glibc 2.28 or newer.' >&2; exit 1; }

# Validate a staged configuration before replacing any installed file. The
# configure/check commands do not open the queue or create an Agent identity.
staged_config="$tmp_dir/config.json"
if [ -f "$config_path" ]; then cp -p "$config_path" "$staged_config"
elif [ -n "$config_source" ]; then cp "$config_source" "$staged_config"; fi
if [ -n "$endpoint" ]; then
  printf '%s\n' "$reporting_key" | "$tmp_dir/unpacked/lightmoni-agent" configure --config "$staged_config" --endpoint "$endpoint" --group-id "$group_id" --key-stdin --require-data-dir /var/lib/lightmoni-agent
elif [ -n "$group_id" ]; then
  "$tmp_dir/unpacked/lightmoni-agent" configure --config "$staged_config" --group-id "$group_id" --require-data-dir /var/lib/lightmoni-agent
fi
"$tmp_dir/unpacked/lightmoni-agent" check --config "$staged_config" --require-data-dir /var/lib/lightmoni-agent

# Preserve old Go binaries as well as the Node launcher's current symlink.
# Backups retain modes, ownership and symlink identity for an atomic rollback.
for item in config launcher service current; do
  case "$item" in
    config) installed="$config_path" ;;
    launcher) installed="/usr/local/bin/lightmoni-agent" ;;
    service) installed="/etc/systemd/system/lightmoni-agent.service" ;;
    current) installed="/opt/lightmoni-agent/current" ;;
  esac
  if [ -e "$installed" ] || [ -L "$installed" ]; then
    [ ! -d "$installed" ] || [ -L "$installed" ] || { echo "Refusing to replace a directory at $installed" >&2; exit 1; }
    cp -Pp "$installed" "$tmp_dir/previous-$item"
  fi
done
if systemctl is-active --quiet lightmoni-agent.service; then previous_active="yes"; fi
if systemctl is-enabled --quiet lightmoni-agent.service; then previous_enabled="yes"; fi
transaction_started="yes"
if id lightmoni-agent >/dev/null 2>&1; then :; else
  command -v useradd >/dev/null || { echo 'useradd is required.' >&2; exit 1; }
  useradd --system --no-create-home --home-dir /var/lib/lightmoni-agent --shell /usr/sbin/nologin lightmoni-agent
fi
install -d -m 0700 -o lightmoni-agent -g lightmoni-agent /etc/lightmoni-agent /var/lib/lightmoni-agent
install -m 0600 -o lightmoni-agent -g lightmoni-agent "$staged_config" "/etc/lightmoni-agent/.config.new-$$"
mv -f "/etc/lightmoni-agent/.config.new-$$" "$config_path"
# The live queue, receipts, cursors, identity and cached tasks stay untouched.
install -d -m 0755 /opt/lightmoni-agent/releases
runtime_release="/opt/lightmoni-agent/releases/${version}-$(printf '%s' "$actual" | cut -c1-16)-$$"
cp -R "$tmp_dir/unpacked/lightmoni-agent-runtime" "$runtime_release"
chmod -R go-w "$runtime_release"
ln -s "$runtime_release" "/opt/lightmoni-agent/.current-$$"
mv -Tf "/opt/lightmoni-agent/.current-$$" /opt/lightmoni-agent/current
install -m 0755 "$tmp_dir/unpacked/lightmoni-agent" "/usr/local/bin/.lightmoni-agent.new-$$"
mv -f "/usr/local/bin/.lightmoni-agent.new-$$" /usr/local/bin/lightmoni-agent
service_changed="yes"
install -m 0644 "$tmp_dir/unpacked/lightmoni-agent.service" /etc/systemd/system/lightmoni-agent.service
systemctl daemon-reload
enable_attempted="yes"
systemctl enable lightmoni-agent.service
restart_attempted="yes"
systemctl restart lightmoni-agent.service
systemctl is-active --quiet lightmoni-agent.service
transaction_started="no"
echo 'LightMoni Agent installed. Existing identity and spool were preserved.'
