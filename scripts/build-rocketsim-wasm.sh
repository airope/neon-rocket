#!/usr/bin/env bash
# Pinned, clean source build. No local RocketSim checkout or cached archive is trusted.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REVISION=c2baacb8f4b441dd8505e63c2aeb5a1679b60b02
EMSCRIPTEN_VERSION=6.0.3
DIST="$ROOT/native/rocketsim/dist"
for tool in git cmake emcmake em++ node; do
  command -v "$tool" >/dev/null || { printf 'Required tool not found: %s\n' "$tool" >&2; exit 1; }
done
VERSION="$(em++ --version)"
if [[ ! "$VERSION" =~ \ 6\.0\.3(-git)?($|[[:space:]]) ]]; then
  printf 'Expected Emscripten %s; got:\n%s\n' "$EMSCRIPTEN_VERSION" "$VERSION" >&2
  exit 1
fi
if [[ -n "${ROCKETSIM_SOURCE:-}" || -n "${BUILD_DIR:-}" ]]; then
  printf 'ROCKETSIM_SOURCE/BUILD_DIR overrides are no longer accepted; builds use fresh pinned source.\n' >&2
  exit 1
fi
mkdir -p "$DIST"
WORK="$(mktemp -d "$ROOT/native/rocketsim/.build.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
export LC_ALL=C TZ=UTC
# Fetch the exact object, never a moving branch; do not read the developer checkout.
git init -q "$WORK/repo"
git -C "$WORK/repo" remote add origin https://github.com/ZealanL/RocketSim.git
git -C "$WORK/repo" fetch --quiet --depth 1 origin "$REVISION"
[[ "$(git -C "$WORK/repo" rev-parse FETCH_HEAD)" == "$REVISION" ]]
export SOURCE_DATE_EPOCH="$(git -C "$WORK/repo" show -s --format=%ct "$REVISION")"
mkdir "$WORK/source"
git -C "$WORK/repo" archive "$REVISION" | tar -xf - -C "$WORK/source"
SOURCE="$WORK/source"
# Always configure/build fresh: stale libRocketSim.a must never short-circuit provenance.
emcmake cmake -S "$SOURCE" -B "$WORK/build" -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Release
cmake --build "$WORK/build" --parallel "${BUILD_JOBS:-4}"
em++ \
  "$ROOT/native/rocketsim/rocketsim_c_api.cpp" \
  "$WORK/build/libRocketSim.a" \
  -iquote "$SOURCE/src" \
  -iquote "$SOURCE/libsrc/bullet3-3.24" \
  -std=c++20 -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createRocketSimRawModule \
  -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_rs_init","_rs_create_arena","_rs_destroy_arena","_rs_add_static_mesh","_rs_add_octane","_rs_set_car_state","_rs_set_car_boost","_rs_get_ball","_rs_set_ball_state","_rs_ball_state_float_count","_rs_write_ball_state","_rs_set_controls","_rs_step","_rs_state_float_count","_rs_write_car_state","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU32"]' \
  -o "$WORK/rocketsim-raw.mjs"
# Publish only after successful compilation/linking.
cp "$WORK/rocketsim-raw.mjs" "$WORK/rocketsim-raw.wasm" "$DIST/"
node "$ROOT/scripts/embed-rocketsim-wasm.mjs" "${BUNDLE_OUTPUT:-$ROOT/shared/rocketsim-wasm-bundled.js}"
node "$ROOT/native/rocketsim/build-manifest.mjs" "$REVISION" "$SOURCE"
printf 'Built pinned RocketSim %s with Emscripten %s\n' "$REVISION" "$EMSCRIPTEN_VERSION"
