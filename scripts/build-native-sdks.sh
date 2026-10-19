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
# Keep a reused release directory from advertising packages that were removed
# from the current support matrix. Docker builds start with an empty directory,
# but local release builds commonly reuse runtime/downloads.
rm -f "$release_dir"/lightmoni-java-sdk_*.tar.gz \
      "$release_dir"/lightmoni-dotnet-sdk_*.tar.gz \
      "$release_dir"/lightmoni-php-sdk_*.tar.gz \
      "$release_dir"/lightmoni-go-sdk_*.tar.gz \
      "$release_dir"/lightmoni-rust-sdk_*.tar.gz
sdk_tmp=$(mktemp -d)
trap 'rm -rf "$sdk_tmp"' EXIT HUP INT TERM
# Go and Rust sources remain for later validation; current releases exclude them.
for language in python ruby; do
  root="$sdk_tmp/lightmoni-$language-sdk"
  mkdir -p "$root/sdk/$language" "$root/examples/sdk/$language"
  case "$language" in
    python) cp sdk/python/pyproject.toml "$root/sdk/python/"; mkdir -p "$root/sdk/python/lightmoni"; cp sdk/python/lightmoni/*.py "$root/sdk/python/lightmoni/" ;;
    ruby) cp sdk/ruby/*.gemspec "$root/sdk/ruby/"; cp -R sdk/ruby/lib "$root/sdk/ruby/" ;;
  esac
  if [ -d "examples/sdk/$language" ]; then
    for file in examples/sdk/"$language"/*; do if [ -f "$file" ]; then cp "$file" "$root/examples/sdk/$language/"; fi; done
  fi
  cp sdk/"$language"/README.md "$root/sdk/$language/"
  cp sdk/README.md "$root/sdk/README.md"
  sed 's|(../README.md|(sdk/README.md|g' sdk/"$language"/README.md > "$root/README.md"
  tar -czf "$release_dir/lightmoni-$language-sdk_$version.tar.gz" -C "$sdk_tmp" "lightmoni-$language-sdk"
done
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$release_dir" && sha256sum "lightmoni-python-sdk_$version.tar.gz" "lightmoni-ruby-sdk_$version.tar.gz" > SDK_SHA256SUMS)
  if [ -f "$release_dir/lightmoni-sdk-$version.tgz" ]; then (cd "$release_dir" && sha256sum "lightmoni-sdk-$version.tgz" >> SDK_SHA256SUMS); fi
else
  (cd "$release_dir" && shasum -a 256 "lightmoni-python-sdk_$version.tar.gz" "lightmoni-ruby-sdk_$version.tar.gz" > SDK_SHA256SUMS)
  if [ -f "$release_dir/lightmoni-sdk-$version.tgz" ]; then (cd "$release_dir" && shasum -a 256 "lightmoni-sdk-$version.tgz" >> SDK_SHA256SUMS); fi
fi
