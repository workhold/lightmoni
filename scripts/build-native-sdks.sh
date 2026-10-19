#!/bin/sh
set -eu
version=0.1.0
output=runtime/downloads
if [ "$#" -gt 0 ]; then version=$1; fi
if [ "$#" -gt 1 ]; then output=$2; fi
case "$version" in *[!0-9A-Za-z._-]*|'') echo "invalid SDK version" >&2; exit 1 ;; esac
source_version=$(sed -n 's/^version = "\(.*\)"/\1/p' sdk/python/pyproject.toml)
if [ "$version" != "$source_version" ]; then echo "SDK source version and release version differ" >&2; exit 1; fi
mkdir -p "$output"
release_dir=$(cd "$output" && pwd)
sdk_tmp=$(mktemp -d)
trap 'rm -rf "$sdk_tmp"' EXIT HUP INT TERM
for language in python rust; do
  root="$sdk_tmp/lightmoni-$language-sdk"
  mkdir -p "$root/sdk/$language" "$root/examples/sdk/$language"
  case "$language" in
    python) cp sdk/python/pyproject.toml "$root/sdk/python/"; mkdir -p "$root/sdk/python/lightmoni"; cp sdk/python/lightmoni/*.py "$root/sdk/python/lightmoni/" ;;
    rust) cp sdk/rust/Cargo.toml sdk/rust/Cargo.lock "$root/sdk/rust/"; cp -R sdk/rust/src sdk/rust/examples "$root/sdk/rust/" ;;
  esac
  if [ -d "examples/sdk/$language" ]; then
    for file in examples/sdk/"$language"/*; do if [ -f "$file" ]; then cp "$file" "$root/examples/sdk/$language/"; fi; done
  fi
  cp sdk/"$language"/README.md "$root/sdk/$language/"
  cp sdk/README.md "$root/sdk/README.md"
  sed 's|(../README.md|(sdk/README.md|g' sdk/"$language"/README.md > "$root/README.md"
  tar -czf "$release_dir/lightmoni-$language-sdk_$version.tar.gz" -C "$sdk_tmp" "lightmoni-$language-sdk"
done
set -- "lightmoni-python-sdk_$version.tar.gz" "lightmoni-rust-sdk_$version.tar.gz"
if [ -f "$release_dir/lightmoni-go-sdk_$version.tar.gz" ]; then set -- "lightmoni-go-sdk_$version.tar.gz" "$@"; fi
if [ -f "$release_dir/lightmoni-sdk-$version.tgz" ]; then set -- "$@" "lightmoni-sdk-$version.tgz"; fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$release_dir" && sha256sum "$@" > SDK_SHA256SUMS)
else
  (cd "$release_dir" && shasum -a 256 "$@" > SDK_SHA256SUMS)
fi
