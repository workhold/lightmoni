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
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
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
tar -xzf "$tmp_dir/$artifact" -C "$tmp_dir/unpacked" lightmoni-agent lightmoni-agent.service
[ -f "$tmp_dir/unpacked/lightmoni-agent" ] && [ ! -L "$tmp_dir/unpacked/lightmoni-agent" ] || { echo 'Invalid release binary.' >&2; exit 1; }

if id lightmoni-agent >/dev/null 2>&1; then :; else
  command -v useradd >/dev/null || { echo 'useradd is required.' >&2; exit 1; }
  useradd --system --no-create-home --home-dir /var/lib/lightmoni-agent --shell /usr/sbin/nologin lightmoni-agent
fi
install -d -m 0700 -o lightmoni-agent -g lightmoni-agent /etc/lightmoni-agent /var/lib/lightmoni-agent
if [ ! -f "$config_path" ] && [ -n "$config_source" ]; then install -m 0600 -o lightmoni-agent -g lightmoni-agent "$config_source" "$config_path"; fi
if [ -n "$endpoint" ]; then
  printf '%s\n' "$reporting_key" | "$tmp_dir/unpacked/lightmoni-agent" configure --config "$config_path" --endpoint "$endpoint" --group-id "$group_id" --key-stdin --require-data-dir /var/lib/lightmoni-agent
  chown lightmoni-agent:lightmoni-agent "$config_path"
elif [ -n "$group_id" ]; then
  "$tmp_dir/unpacked/lightmoni-agent" configure --config "$config_path" --group-id "$group_id" --require-data-dir /var/lib/lightmoni-agent
  chown lightmoni-agent:lightmoni-agent "$config_path"
fi
"$tmp_dir/unpacked/lightmoni-agent" check --config "$config_path" --require-data-dir /var/lib/lightmoni-agent
install -m 0755 "$tmp_dir/unpacked/lightmoni-agent" /usr/local/bin/.lightmoni-agent.new
mv /usr/local/bin/.lightmoni-agent.new /usr/local/bin/lightmoni-agent
install -m 0644 "$tmp_dir/unpacked/lightmoni-agent.service" /etc/systemd/system/lightmoni-agent.service
systemctl daemon-reload
systemctl enable lightmoni-agent.service
systemctl restart lightmoni-agent.service
echo 'LightMoni Agent installed. Existing identity, configuration and spool were preserved.'
