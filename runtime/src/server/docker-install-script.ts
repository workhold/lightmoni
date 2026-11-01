// Runs only through the protected SSH lifecycle channel as root.
export const dockerInstallScript = `#!/bin/sh
# Fixed platform-owned installer. No credentials or user-provided shell fragments.
set -eu
exec >/dev/null 2>&1
install_dir=$1
state=running
phase=checking_system
code=
write_status() {
  public_code=$code
  [ "$state" != running ] || public_code=
  printf '{"state":"%s","phase":"%s","code":"%s"}\\n' "$state" "$phase" "$public_code" > "$install_dir/status.tmp"
  mv -f "$install_dir/status.tmp" "$install_dir/status.json"
}
finish() { result=$?; if [ "$state" != succeeded ]; then state=failed; [ -n "$code" ] || code=docker_install_failed; fi; write_status; exit "$result"; }
trap finish EXIT
trap 'code=docker_install_interrupted; exit 1' HUP INT TERM
write_status
[ "$(id -u)" = 0 ] || { code=docker_install_privilege_required; exit 1; }
command -v flock >/dev/null || { code=docker_install_unsupported; exit 1; }
exec 9>/run/lightmoni-docker-install.lock
flock -n 9 || { code=docker_install_busy; exit 1; }
[ "$(uname -s)" = Linux ] || { code=docker_install_unsupported; exit 1; }
case "$(uname -m)" in x86_64|aarch64) ;; *) code=docker_install_unsupported; exit 1;; esac
[ -f /etc/os-release ] || { code=docker_install_unsupported; exit 1; }
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) code=docker_install_unsupported; exit 1;; esac
[ -d /run/systemd/system ] || { code=docker_install_unsupported; exit 1; }
need_engine=0
need_compose=0
command -v docker >/dev/null || need_engine=1
if [ "$need_engine" = 1 ] || ! docker --context default compose version --short >/dev/null 2>&1; then need_compose=1; fi
if [ "$need_engine" = 1 ] || [ "$need_compose" = 1 ]; then
  # Never uninstall competing packages or replace another runtime implicitly.
  for pkg in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if dpkg-query -W -f='$'"{Status}" "$pkg" 2>/dev/null | grep -q '^install ok installed$'; then code=docker_install_package_conflict; exit 1; fi
  done
  phase=installing_packages
  code=docker_install_package_failed
  write_status
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=60 update -qq
  apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends ca-certificates curl
  # Reuse an existing official source to avoid conflicting Signed-By entries.
  if ! grep -qs "https://download.docker.com/linux/$ID" /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 "https://download.docker.com/linux/$ID/gpg" -o "$install_dir/docker.asc"
    install -m 0644 "$install_dir/docker.asc" /etc/apt/keyrings/lightmoni-docker.asc
    distro_codename=$(printf '%s' "$VERSION_CODENAME" | tr -cd 'a-z0-9')
    [ -n "$distro_codename" ] || { code=docker_install_unsupported; exit 1; }
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/lightmoni-docker.asc] https://download.docker.com/linux/%s %s stable\\n' "$(dpkg --print-architecture)" "$ID" "$distro_codename" > /etc/apt/sources.list.d/lightmoni-docker.list
  fi
  apt-get -o DPkg::Lock::Timeout=60 update -qq
  if [ "$need_engine" = 1 ]; then
    apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends docker-compose-plugin
  fi
fi
phase=starting_docker
code=docker_install_service_failed
write_status
# Start Docker without restarting an existing daemon.
systemctl enable --now docker
phase=verifying_docker
code=docker_install_verification_failed
write_status
docker --context default info --format '{{.ServerVersion}}' >/dev/null
docker --context default compose version --short >/dev/null
state=succeeded
phase=verified
code=
`;
