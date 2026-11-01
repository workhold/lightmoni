#!/bin/sh
set -eu
umask 077

version="0.1.0"
fresh="no"
release_url=""
release_dir=""
config_source=""
endpoint=""
group_id=""
enrollment_token_stdin=""
enrollment_token=""
bootstrap_credential=""
agent_id=""
install_nonce=""
agent_public_key=""
enrollment_mode="no"

usage() {
  echo 'Usage: install.sh (--release-url URL --enrollment-token-stdin | --release-dir DIR) [--fresh] [--version VERSION] [--config FILE | --endpoint URL --enrollment-token-stdin] [--group-id GROUP]'
  echo 'The reporting configuration is generated automatically. Existing identity and cached data are preserved.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fresh) fresh="yes"; shift ;;
    --version) version="$2"; shift 2 ;;
    --release-url) release_url="$2"; shift 2 ;;
    --release-dir) release_dir="$2"; shift 2 ;;
    --config) config_source="$2"; shift 2 ;;
    --endpoint) endpoint="$2"; shift 2 ;;
    --group-id) group_id="$2"; shift 2 ;;
    --enrollment-token-stdin) enrollment_token_stdin="yes"; shift ;;
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
[ -n "$release_url" ] || [ -z "$endpoint" ] || release_url="${endpoint%/}/downloads/agent"
[ -n "$release_dir" ] || [ -n "$release_url" ] || { usage >&2; exit 1; }

config_path="/etc/lightmoni-agent/config.json"
if [ ! -f "$config_path" ] && [ -z "$config_source" ] && [ -z "$endpoint" ]; then
  echo 'First installation requires a registered-host deployment enrollment; use LightMoni host management.' >&2
  exit 1
fi
if [ -n "$enrollment_token_stdin" ]; then
  [ -n "$endpoint" ] || { echo '--enrollment-token-stdin requires --endpoint.' >&2; exit 1; }
  enrollment_mode="yes"
elif [ -n "$endpoint" ]; then
  echo 'A reporting address requires --enrollment-token-stdin from a registered-host deployment.' >&2
  exit 1
fi
if [ -n "$config_source" ]; then [ -f "$config_source" ] || { echo 'Configuration file missing.' >&2; exit 1; }; fi

lifecycle_lock=/run/lightmoni-agent-lifecycle.lock
lifecycle_locked="no"
tmp_dir="$(mktemp -d)"
transaction_started="no"
service_changed="no"
restart_attempted="no"
enable_attempted="no"
previous_active="no"
previous_enabled="no"
runtime_release=""
runtime_base_created="no"
releases_directory_created="no"
uninstaller_directory_created="no"
rollback_failed="no"
permission_retirement_started="no"
installation_phase="install-files"
wait_service_active() {
  startup_attempt=0
  active_observations=0
  while [ "$startup_attempt" -lt 10 ]; do
    startup_attempt=$((startup_attempt + 1))
    if systemctl is-active --quiet lightmoni-agent.service; then
      active_observations=$((active_observations + 1))
      [ "$active_observations" -lt 2 ] || return 0
    else
      active_observations=0
    fi
    if [ "$startup_attempt" -lt 10 ]; then sleep 1; fi
  done
  return 1
}
report_service_failure() {
  echo "Agent installation failed during: $installation_phase" >&2
  # Read only fixed status properties, before stopping or restoring the unit.
  # Raw journal/status output may contain application arguments or secrets.
  systemctl show lightmoni-agent.service --no-pager \
    --property=LoadState --property=ActiveState --property=SubState \
    --property=Result --property=ExecMainCode --property=ExecMainStatus \
    >&2 2>/dev/null || echo 'Systemd diagnostic properties unavailable.' >&2
  echo 'Inspect locally: sudo journalctl -u lightmoni-agent.service -n 100 --no-pager' >&2
}
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
    report_service_failure
    echo 'Installation failed; restoring the previous Agent installation and configuration.' >&2
    if [ "$restart_attempted" = "yes" ]; then systemctl stop lightmoni-agent.service || rollback_failed="yes"; fi
    restore_file /etc/lightmoni-agent/config.json "$tmp_dir/previous-config"
    restore_file /usr/local/bin/lightmoni-agent "$tmp_dir/previous-launcher"
    restore_file /usr/local/sbin/lightmoni-agent-uninstall "$tmp_dir/previous-uninstaller"
    if [ -e "$tmp_dir/previous-service" ] && ! ordinary_service "$tmp_dir/previous-service"; then
      # Keep the exact old unit in the transaction evidence. Never restore its
      # group/capability grant or leave it enabled after a failed migration.
      systemctl stop lightmoni-agent.service || rollback_failed=yes
      if ordinary_service "$tmp_dir/unpacked/lightmoni-agent.service"; then
        install -m 0644 "$tmp_dir/unpacked/lightmoni-agent.service" /etc/systemd/system/lightmoni-agent.service || rollback_failed=yes
        service_changed=yes
      fi
      systemctl disable lightmoni-agent.service || rollback_failed=yes
      rollback_failed=yes
    else
      restore_file /etc/systemd/system/lightmoni-agent.service "$tmp_dir/previous-service"
    fi
    restore_file /opt/lightmoni-agent/current "$tmp_dir/previous-current"
    if [ "$enrollment_mode" = "yes" ]; then
      restore_file /var/lib/lightmoni-agent/identity.json "$tmp_dir/previous-identity"
    fi
    if [ "$service_changed" = "yes" ]; then systemctl daemon-reload || rollback_failed="yes"; fi
    if [ "$permission_retirement_started" = yes ]; then
      if ! inspect_legacy_docker_access || [ "$legacy_docker_present" = yes ]; then rollback_failed=yes; fi
    fi
    if [ "$enable_attempted" = "yes" ] && [ "$rollback_failed" = no ]; then
      if [ "$previous_enabled" = "yes" ]; then systemctl enable lightmoni-agent.service || rollback_failed="yes"
      else systemctl disable lightmoni-agent.service || rollback_failed="yes"; fi
    fi
    if [ "$restart_attempted" = "yes" ] && [ "$previous_active" = "yes" ] && [ "$rollback_failed" = no ]; then
      systemctl restart lightmoni-agent.service || rollback_failed="yes"
      systemctl is-active --quiet lightmoni-agent.service || rollback_failed="yes"
    fi
    rm -f "/opt/lightmoni-agent/.current-$$" "/usr/local/bin/.lightmoni-agent.new-$$" "/usr/local/sbin/.lightmoni-agent-uninstall.new-$$" "/etc/lightmoni-agent/.config.new-$$" "/var/lib/lightmoni-agent/.identity.new-$$"
    if [ "$rollback_failed" = "no" ]; then
      if [ -n "$runtime_release" ]; then rm -rf "$runtime_release"; fi
      # Remove only empty program directories created by this attempt. Their
      # presence otherwise makes the next --fresh attempt reject its own rollback.
      if [ "$releases_directory_created" = "yes" ]; then rmdir /opt/lightmoni-agent/releases 2>/dev/null || :; fi
      if [ "$runtime_base_created" = "yes" ]; then rmdir /opt/lightmoni-agent 2>/dev/null || :; fi
      if [ "$uninstaller_directory_created" = "yes" ]; then rmdir /usr/local/sbin 2>/dev/null || :; fi
    fi
  fi
  if [ "$rollback_failed" = "yes" ]; then
    echo "Automatic restoration needs attention; previous files remain in $tmp_dir" >&2
  else
    rm -rf "$tmp_dir"
  fi
  if [ "$lifecycle_locked" = "yes" ] && [ "$rollback_failed" = no ]; then rmdir "$lifecycle_lock" || true; fi
  exit "$result"
}
trap 'finish "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$lifecycle_lock" || { echo 'Agent lifecycle operation already in progress.' >&2; exit 1; }
lifecycle_locked="yes"
if [ "$fresh" = "yes" ] && { [ -e /usr/local/bin/lightmoni-agent ] || [ -L /usr/local/bin/lightmoni-agent ] || [ -e /opt/lightmoni-agent ] || [ -e /etc/systemd/system/lightmoni-agent.service ] || [ -e /etc/lightmoni-agent/config.json ] || [ -e /var/lib/lightmoni-agent/identity.json ]; }; then
  echo 'Existing Agent installation detected; inspect or uninstall it before a fresh installation.' >&2
  exit 1
fi
if [ "$enrollment_token_stdin" = "yes" ]; then
  IFS= read -r enrollment_token || :
  [ -n "$enrollment_token" ] || { echo 'An enrollment token is required.' >&2; exit 1; }
fi
if [ -z "$release_dir" ] && [ -z "$enrollment_token" ]; then
  echo 'Online installation requires --enrollment-token-stdin to authenticate LightMoni Agent downloads.' >&2
  exit 1
fi
artifact="lightmoni-agent_${version}_linux_${arch}.tar.gz"
if [ -n "$release_dir" ]; then
  cp "$release_dir/$artifact" "$tmp_dir/$artifact"
  cp "$release_dir/SHA256SUMS" "$tmp_dir/SHA256SUMS"
else
  command -v curl >/dev/null || { echo 'curl is required for online installation.' >&2; exit 1; }
  download_credential="$enrollment_token"
  # Keep the secret out of curl's argv and environment. The config file is
  # mode 0600 and is removed with the transaction directory on every exit.
  curl_auth="$tmp_dir/curl-auth.conf"
  printf 'header = "Authorization: Bearer %s"\n' "$download_credential" > "$curl_auth"
  curl --fail --silent --show-error --location --config "$curl_auth" "$release_url/$artifact" --output "$tmp_dir/$artifact"
  curl --fail --silent --show-error --location --config "$curl_auth" "$release_url/SHA256SUMS" --output "$tmp_dir/SHA256SUMS"
fi
expected="$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$tmp_dir/SHA256SUMS")"
[ "${#expected}" = "64" ] || { echo 'Release checksum missing or ambiguous.' >&2; exit 1; }
actual="$(sha256sum "$tmp_dir/$artifact" | awk '{ print $1 }')"
[ "$expected" = "$actual" ] || { echo 'Release checksum verification failed.' >&2; exit 1; }
mkdir "$tmp_dir/unpacked"
tar -xzf "$tmp_dir/$artifact" -C "$tmp_dir/unpacked" lightmoni-agent lightmoni-agent.service lightmoni-agent-runtime
[ -f "$tmp_dir/unpacked/lightmoni-agent" ] && [ ! -L "$tmp_dir/unpacked/lightmoni-agent" ] || { echo 'Invalid release binary.' >&2; exit 1; }
has_uninstaller="no"
if [ -e "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" ] || [ -L "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" ]; then
  [ -f "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" ] && [ ! -L "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" ] || { echo 'Invalid offline uninstaller in the release.' >&2; exit 1; }
  has_uninstaller="yes"
# Source only the shared, side-effect-free guards from the checksum-verified
# standalone script. Never execute the uninstaller during installation.
sed -n '/^# BEGIN SHARED MAINTENANCE GUARDS$/,/^# END SHARED MAINTENANCE GUARDS$/p' "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" > "$tmp_dir/maintenance-guards.sh"
. "$tmp_dir/maintenance-guards.sh"
lm_assert_paths
fi
[ -x "$tmp_dir/unpacked/lightmoni-agent-runtime/node" ] || { echo 'Bundled Node runtime is missing.' >&2; exit 1; }
"$tmp_dir/unpacked/lightmoni-agent-runtime/node" --version >/dev/null || { echo 'The release requires Linux with glibc 2.28 or newer.' >&2; exit 1; }
node="$tmp_dir/unpacked/lightmoni-agent-runtime/node"
ordinary_service() {
  "$node" -e 'const fs=require("node:fs"),c=require("node:crypto"),p=process.argv[1],s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>8192||c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!=="651b2b126af0e96dfd26bbe6fc3e438f2f1a71814cff4009ec8fdeeaadb21bbf")process.exit(1);' "$1"
}
ordinary_service "$tmp_dir/unpacked/lightmoni-agent.service" || { echo 'agent_privilege_migration_required' >&2; exit 1; }
# Only this exact platform-owned legacy grant may be retired. Other systemd
# overrides remain administrator evidence and require explicit local migration.
inspect_legacy_docker_access() {
  legacy_docker_dir=/etc/systemd/system/lightmoni-agent.service.d
  legacy_docker_file="$legacy_docker_dir/20-lightmoni-docker.conf"
  for legacy_path in /etc /etc/systemd /etc/systemd/system "$legacy_docker_dir"; do
    [ ! -L "$legacy_path" ] || { echo 'agent_dropin_migration_required' >&2; return 1; }
    if [ -e "$legacy_path" ]; then
      [ -d "$legacy_path" ] || return 1
      stat -c '%u:%a' -- "$legacy_path" | LC_ALL=C awk -F: '$1=="0" && $2 ~ /^([0-7])?[0-7][0145][0145]$/ {safe=1} END {exit !safe}' || return 1
    fi
  done
  legacy_effective=$(systemctl show lightmoni-agent.service --property=DropInPaths --value) || return 1
  case "$legacy_effective" in ""|"$legacy_docker_file") ;; *) echo 'agent_dropin_migration_required' >&2; return 1;; esac
  if [ -d "$legacy_docker_dir" ]; then
    for legacy_path in "$legacy_docker_dir"/* "$legacy_docker_dir"/.[!.]* "$legacy_docker_dir"/..?*; do
      if [ -e "$legacy_path" ] || [ -L "$legacy_path" ]; then
        [ "$legacy_path" = "$legacy_docker_file" ] || { echo 'agent_dropin_migration_required' >&2; return 1; }
      fi
    done
  fi
  legacy_docker_present=no
  if [ -e "$legacy_docker_file" ] || [ -L "$legacy_docker_file" ]; then
    [ ! -L "$legacy_docker_file" ] && [ -f "$legacy_docker_file" ] || return 1
    stat -c '%u:%a' -- "$legacy_docker_file" | LC_ALL=C awk -F: '$1=="0" && $2 ~ /^([0-7])?[0-7][0145][0145]$/ {safe=1} END {exit !safe}' || return 1
    printf '[Service]\nSupplementaryGroups=docker\n' > "$tmp_dir/legacy-docker-expected"
    cmp -s "$legacy_docker_file" "$tmp_dir/legacy-docker-expected" || { echo 'agent_dropin_migration_required' >&2; return 1; }
    legacy_docker_present=yes
  else
    [ -z "$legacy_effective" ] || return 1
  fi
}
inspect_legacy_docker_access
write_curl_auth() {
  curl_auth="$tmp_dir/curl-auth.conf"
  printf 'header = "Authorization: Bearer %s"\n' "$1" > "$curl_auth"
  chmod 0600 "$curl_auth"
}
json_value() {
  "$node" -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(typeof value!=="string"||!value)process.exit(2);process.stdout.write(value);' "$1" "$2"
}
rewrite_credentials() {
  control_file="$tmp_dir/control-credential"
  data_file="$tmp_dir/data-credential"
  printf '%s' "$control_credential" > "$control_file"
  printf '%s' "$data_credential" > "$data_file"
  "$node" -e 'const fs=require("node:fs");const [path,controlPath,dataPath]=process.argv.slice(1);const config=JSON.parse(fs.readFileSync(path,"utf8"));config.control_credential=fs.readFileSync(controlPath,"utf8");config.data_credential=fs.readFileSync(dataPath,"utf8");fs.writeFileSync(path,JSON.stringify(config,null,2)+"\n",{mode:0o600});fs.chmodSync(path,0o600);' "$staged_config" "$control_file" "$data_file"
}
stage_identity() {
  staged_identity="$tmp_dir/identity.json"
  "$node" -e 'const fs=require("node:fs"),crypto=require("node:crypto");const [source,destination,agentID]=process.argv.slice(1);let hostID="";try{const old=JSON.parse(fs.readFileSync(source,"utf8"));hostID=typeof old.host_id==="string"?old.host_id:"";}catch{}if(!hostID)hostID=crypto.randomUUID();fs.writeFileSync(destination,JSON.stringify({agent_id:agentID,host_id:hostID})+"\n",{mode:0o600});fs.chmodSync(destination,0o600);' "/var/lib/lightmoni-agent/identity.json" "$staged_identity" "$agent_id"
}

if [ "$enrollment_mode" = "yes" ]; then
  command -v curl >/dev/null || { echo 'curl is required for enrollment.' >&2; exit 1; }
  install_nonce="$($node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  agent_public_key="ed25519:$($node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  write_curl_auth "$enrollment_token"
  enroll_response="$tmp_dir/enroll.json"
  printf '{"enrollment_token":"%s","install_nonce":"%s","agent_public_key":"%s","version":"%s","arch":"%s"}\n' \
    "$enrollment_token" "$install_nonce" "$agent_public_key" "$version" "$arch" |
    curl --fail --silent --show-error --location --config "$curl_auth" \
      --header 'Content-Type: application/json' --data-binary @- \
      "${endpoint%/}/api/v1/agents/enroll" --output "$enroll_response"
  agent_id="$(json_value "$enroll_response" agent_id)"
  bootstrap_credential="$(json_value "$enroll_response" bootstrap_credential)" || {
    echo 'Enrollment was already started; use the original installer process or create a new enrollment token.' >&2
    exit 1
  }
fi

# Validate a staged configuration before replacing any installed file. The
# configure/check commands do not open the queue or create an Agent identity.
staged_config="$tmp_dir/config.json"
if [ -f "$config_path" ]; then cp -p "$config_path" "$staged_config"
elif [ -n "$config_source" ]; then cp "$config_source" "$staged_config"; fi
if [ "$enrollment_mode" = "yes" ]; then
  "$tmp_dir/unpacked/lightmoni-agent" configure --config "$staged_config" --endpoint "$endpoint" --group-id "$group_id" --pending-enrollment --require-data-dir /var/lib/lightmoni-agent
  "$tmp_dir/unpacked/lightmoni-agent" check --config "$staged_config" --pending-enrollment --require-data-dir /var/lib/lightmoni-agent
else
  if [ -n "$group_id" ]; then
    "$tmp_dir/unpacked/lightmoni-agent" configure --config "$staged_config" --group-id "$group_id" --require-data-dir /var/lib/lightmoni-agent
  fi
  "$tmp_dir/unpacked/lightmoni-agent" check --config "$staged_config" --require-data-dir /var/lib/lightmoni-agent
fi

if [ "$enrollment_mode" = "yes" ]; then
  # The bootstrap credential is used only for this health-gated activation;
  # it is never copied into the installed configuration.
  write_curl_auth "$bootstrap_credential"
  activation_response="$tmp_dir/activate.json"
  printf '{"install_nonce":"%s","health":{"service":"ready","config_checked":true}}\n' "$install_nonce" |
    curl --fail --silent --show-error --location --config "$curl_auth" \
      --header 'Content-Type: application/json' --data-binary @- \
      "${endpoint%/}/api/v1/agents/$agent_id/activate" --output "$activation_response"
  control_credential="$(json_value "$activation_response" control_credential)"
  data_credential="$(json_value "$activation_response" data_credential)"
  rewrite_credentials
  stage_identity
  "$tmp_dir/unpacked/lightmoni-agent" check --config "$staged_config" --require-data-dir /var/lib/lightmoni-agent
fi

# Preserve old Go binaries as well as the Node launcher's current symlink.
# Backups retain modes, ownership and symlink identity for an atomic rollback.
for item in config launcher uninstaller service current identity; do
  case "$item" in
    config) installed="$config_path" ;;
    launcher) installed="/usr/local/bin/lightmoni-agent" ;;
    uninstaller) installed="/usr/local/sbin/lightmoni-agent-uninstall" ;;
    service) installed="/etc/systemd/system/lightmoni-agent.service" ;;
    current) installed="/opt/lightmoni-agent/current" ;;
    identity) installed="/var/lib/lightmoni-agent/identity.json" ;;
  esac
  if [ -e "$installed" ] || [ -L "$installed" ]; then
    [ ! -d "$installed" ] || [ -L "$installed" ] || { echo "Refusing to replace a directory at $installed" >&2; exit 1; }
    cp -Pp "$installed" "$tmp_dir/previous-$item"
  fi
done
if systemctl is-active --quiet lightmoni-agent.service; then previous_active="yes"; fi
if systemctl is-enabled --quiet lightmoni-agent.service; then previous_enabled="yes"; fi
transaction_started="yes"
inspect_legacy_docker_access
if [ "$legacy_docker_present" = yes ]; then
  installation_phase="retire-legacy-docker-access"
  restart_attempted=yes
  permission_retirement_started=yes
  service_changed=yes
  systemctl stop lightmoni-agent.service
  legacy_active=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
  case "$legacy_active" in inactive|failed) ;; *) echo 'service_stop_failed' >&2; exit 1;; esac
  inspect_legacy_docker_access
  [ "$legacy_docker_present" = yes ] || { echo 'agent_dropin_migration_required' >&2; exit 1; }
  rm "$legacy_docker_file"
  "$node" -e 'const fs=require("node:fs"),fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$legacy_docker_dir"
  service_changed=yes
  # This permission grant is not a program backup. Failure rollback cannot
  # reintroduce Docker access into the restored ordinary Agent.
  echo 'legacy_docker_access_removed'
fi
if id lightmoni-agent >/dev/null 2>&1; then :; else
  command -v useradd >/dev/null || { echo 'useradd is required.' >&2; exit 1; }
  useradd --system --no-create-home --home-dir /var/lib/lightmoni-agent --shell /usr/sbin/nologin lightmoni-agent
fi
install -d -m 0700 -o lightmoni-agent -g lightmoni-agent /etc/lightmoni-agent /var/lib/lightmoni-agent
if [ -f "$tmp_dir/unpacked/lightmoni-agent-runtime/deployment-permissions.mjs" ]; then
  [ ! -L "$tmp_dir/unpacked/lightmoni-agent-runtime/deployment-permissions.mjs" ] || { echo 'Invalid deployment permission helper.' >&2; exit 1; }
  installation_phase="deployment-permissions"
  "$node" "$tmp_dir/unpacked/lightmoni-agent-runtime/deployment-permissions.mjs" prepare
fi
install -m 0600 -o lightmoni-agent -g lightmoni-agent "$staged_config" "/etc/lightmoni-agent/.config.new-$$"
mv -f "/etc/lightmoni-agent/.config.new-$$" "$config_path"
if [ "$enrollment_mode" = "yes" ]; then
  install -m 0600 -o lightmoni-agent -g lightmoni-agent "$staged_identity" "/var/lib/lightmoni-agent/.identity.new-$$"
  mv -f "/var/lib/lightmoni-agent/.identity.new-$$" "/var/lib/lightmoni-agent/identity.json"
fi
# The live queue, receipts, cursors, identity and cached tasks stay untouched.
if [ ! -e /opt/lightmoni-agent ] && [ ! -L /opt/lightmoni-agent ]; then runtime_base_created="yes"; fi
if [ ! -e /opt/lightmoni-agent/releases ] && [ ! -L /opt/lightmoni-agent/releases ]; then releases_directory_created="yes"; fi
install -d -m 0755 /opt/lightmoni-agent /opt/lightmoni-agent/releases
runtime_release="/opt/lightmoni-agent/releases/${version}-$(printf '%s' "$actual" | cut -c1-16)-$$"
cp -R "$tmp_dir/unpacked/lightmoni-agent-runtime" "$runtime_release"
# Public code identity only; credentials never enter an installation receipt.
printf '{"schema":1,"artifact_sha256":"%s"}\n' "$actual" > "$runtime_release/installation.json"
# cp under umask 077 creates root-only directories and files. The dedicated
# service user needs read/traverse access to public code and the bundled Node;
# credentials and persistent data retain their separate 0700/0600 permissions.
chmod -R u=rwX,go=rX "$runtime_release"
ln -s "$runtime_release" "/opt/lightmoni-agent/.current-$$"
mv -Tf "/opt/lightmoni-agent/.current-$$" /opt/lightmoni-agent/current
install -m 0755 "$tmp_dir/unpacked/lightmoni-agent" "/usr/local/bin/.lightmoni-agent.new-$$"
mv -f "/usr/local/bin/.lightmoni-agent.new-$$" /usr/local/bin/lightmoni-agent
if [ "$has_uninstaller" = "yes" ]; then
  if [ ! -e /usr/local/sbin ] && [ ! -L /usr/local/sbin ]; then uninstaller_directory_created="yes"; fi
  install -d -m 0755 /usr/local/sbin
  install -m 0755 "$tmp_dir/unpacked/lightmoni-agent-runtime/uninstall.sh" "/usr/local/sbin/.lightmoni-agent-uninstall.new-$$"
  mv -f "/usr/local/sbin/.lightmoni-agent-uninstall.new-$$" /usr/local/sbin/lightmoni-agent-uninstall
fi
service_changed="yes"
install -m 0644 "$tmp_dir/unpacked/lightmoni-agent.service" /etc/systemd/system/lightmoni-agent.service
installation_phase="daemon-reload"
systemctl daemon-reload
installation_phase="enable"
enable_attempted="yes"
systemctl enable lightmoni-agent.service
installation_phase="restart"
restart_attempted="yes"
systemctl restart lightmoni-agent.service
installation_phase="startup-check"
if ! wait_service_active; then
  echo 'Agent did not remain active during the startup observation window.' >&2
  exit 1
fi
transaction_started="no"
echo 'LightMoni Agent installed. Existing identity and spool were preserved.'
