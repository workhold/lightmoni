#!/bin/sh
set -eu
version=${1:-0.1.0}
output=${2:-runtime/downloads}
mkdir -p "$output"
release_dir=$(cd "$output" && pwd)
npm --prefix sdk/typescript run build
(cd sdk/typescript && npm pack --pack-destination "$release_dir" >/dev/null)
sh scripts/build-go-sdk.sh "$version" "$release_dir"
sh scripts/build-native-sdks.sh "$version" "$release_dir"
