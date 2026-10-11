#!/bin/sh
set -eu
version="${1:-0.1.0}"
output="${2:-dist/agent}"
case "$version" in *[!0-9A-Za-z._-]*|'') echo 'Invalid fixed version.' >&2; exit 1 ;; esac
mkdir -p "$output"
release_dir="$(cd "$output" && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags "-X github.com/lightmoni/lightmoni/internal/agent.Version=$version" -o "$tmp_dir/lightmoni-agent" ./cmd/lightmoni-agent
  cp deploy/agent/lightmoni-agent.service "$tmp_dir/lightmoni-agent.service"
  tar -czf "$release_dir/lightmoni-agent_${version}_linux_${arch}.tar.gz" -C "$tmp_dir" lightmoni-agent lightmoni-agent.service
done
cp deploy/agent/install.sh deploy/agent/uninstall.sh deploy/agent/config.example.json "$release_dir/"
(cd "$release_dir"; if command -v sha256sum >/dev/null; then sha256sum lightmoni-agent_*_linux_*.tar.gz; else shasum -a 256 lightmoni-agent_*_linux_*.tar.gz; fi) > "$release_dir/SHA256SUMS"
echo "Agent release artifacts created in $release_dir"
