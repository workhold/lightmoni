#!/bin/sh
# Deferred SDK: this is an explicit source-package tool, not a current release step.
set -eu
version=${1:-0.1.0}
output=${2:-runtime/downloads}
mkdir -p "$output"
release_dir=$(cd "$output" && pwd)
sdk_tmp=$(mktemp -d)
trap 'rm -rf "$sdk_tmp"' EXIT HUP INT TERM
mkdir -p "$sdk_tmp/lightmoni-go-sdk/sdk/go" "$sdk_tmp/lightmoni-go-sdk/examples/sdk/go"
for file in sdk/go/*.go; do
  case "$file" in *_integration_test.go) continue ;; esac
  cp "$file" "$sdk_tmp/lightmoni-go-sdk/sdk/go/"
done
cp sdk/README.md "$sdk_tmp/lightmoni-go-sdk/sdk/README.md"
cp sdk/go/README.md "$sdk_tmp/lightmoni-go-sdk/sdk/go/README.md"
sed 's|(../README.md|(sdk/README.md|g' sdk/go/README.md > "$sdk_tmp/lightmoni-go-sdk/README.md"
cp examples/sdk/go/main.go "$sdk_tmp/lightmoni-go-sdk/examples/sdk/go/"
cat > "$sdk_tmp/lightmoni-go-sdk/go.mod" <<'EOF'
module github.com/lightmoni/lightmoni

go 1.26.0

require (
 go.opentelemetry.io/proto/otlp v1.11.1
 google.golang.org/protobuf v1.36.12
)
EOF
cp go.sum "$sdk_tmp/lightmoni-go-sdk/go.sum"
(cd "$sdk_tmp/lightmoni-go-sdk" && go mod tidy)
tar -czf "$release_dir/lightmoni-go-sdk_${version}.tar.gz" -C "$sdk_tmp" lightmoni-go-sdk
