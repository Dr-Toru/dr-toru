#!/usr/bin/env bash
#
# Build KenLM as a WebAssembly module via Emscripten.
#
# Prerequisites:
#   - Emscripten SDK (emsdk) activated in PATH
#     https://emscripten.org/docs/getting_started/downloads.html
#   - CMake ≥ 3.15
#
# Usage:
#   ./scripts/build-kenlm-wasm.sh
#
# Output:
#   plugin-bundles/medasr/kenlm/kenlm.js    Emscripten JS glue (ES module, MODULARIZE)
#   plugin-bundles/medasr/kenlm/kenlm.wasm  Compiled WebAssembly binary
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/build/kenlm-wasm"
OUTPUT_DIR="$PROJECT_ROOT/plugin-bundles/medasr/kenlm"
KENLM_DIR="$BUILD_DIR/kenlm"
KENLM_REPO="https://github.com/kpu/kenlm.git"

# ---------- verify emscripten ----------
if ! command -v emcc &>/dev/null; then
  echo "ERROR: emcc not found. Activate the Emscripten SDK first:"
  echo "  source /path/to/emsdk/emsdk_env.sh"
  exit 1
fi
echo "Using emcc: $(emcc --version | head -1)"

# ---------- clone / update kenlm ----------
mkdir -p "$BUILD_DIR"
if [ ! -d "$KENLM_DIR" ]; then
  echo "Cloning KenLM..."
  git clone --depth 1 "$KENLM_REPO" "$KENLM_DIR"
else
  echo "KenLM source found at $KENLM_DIR"
fi

# ---------- apply emscripten patches ----------
echo "Applying Emscripten compatibility patches..."

# Patch 1: secure_getenv → getenv for Emscripten
UTIL_FILE="$KENLM_DIR/util/file.cc"
if grep -q 'secure_getenv' "$UTIL_FILE" 2>/dev/null; then
  sed -i.bak 's/secure_getenv/getenv/g' "$UTIL_FILE"
  echo "  Patched secure_getenv in util/file.cc"
fi

# Patch 2: double-conversion Emscripten detection
DC_UTILS="$KENLM_DIR/util/double-conversion/utils.h"
if [ -f "$DC_UTILS" ] && ! grep -q '__EMSCRIPTEN__' "$DC_UTILS" 2>/dev/null; then
  sed -i.bak 's/defined(__ARMEL__)/defined(__ARMEL__) || defined(__EMSCRIPTEN__)/g' "$DC_UTILS"
  echo "  Patched double-conversion for Emscripten"
fi

# Patch 3: Make Boost optional in CMakeLists.txt
# The core kenlm + kenlm_util libraries only need Boost headers
# (boost/functional/hash.hpp, boost/version.hpp). The linked components
# (program_options, system, thread, unit_test_framework) are only needed
# for tests and executables which we skip.
CMAKELISTS="$KENLM_DIR/CMakeLists.txt"
if grep -q 'REQUIRED COMPONENTS' "$CMAKELISTS" 2>/dev/null; then
  sed -i.bak '
    s/find_package(Boost 1.41.0 REQUIRED COMPONENTS/find_package(Boost 1.41.0 QUIET COMPONENTS/
  ' "$CMAKELISTS"
  echo "  Patched CMakeLists.txt: Boost now optional"
fi

# Patch 4: Remove stream subdirectory from util (needs Boost threads, not needed for querying)
UTIL_CMAKELISTS="$KENLM_DIR/util/CMakeLists.txt"
if [ -f "$UTIL_CMAKELISTS" ] && grep -q 'add_subdirectory(stream)' "$UTIL_CMAKELISTS" 2>/dev/null; then
  sed -i.bak \
    -e 's/add_subdirectory(stream)/# add_subdirectory(stream)  # disabled for WASM/' \
    -e 's/${KENLM_UTIL_STREAM_SOURCE}//' \
    "$UTIL_CMAKELISTS"
  echo "  Patched util/CMakeLists.txt: removed stream subdirectory"
fi

# Patch 5: Remove lm/common (model-building helpers that use stream) from kenlm library
LM_CMAKELISTS="$KENLM_DIR/lm/CMakeLists.txt"
if [ -f "$LM_CMAKELISTS" ] && grep -q 'add_subdirectory(common)' "$LM_CMAKELISTS" 2>/dev/null; then
  sed -i.bak \
    -e 's/add_subdirectory(common)/# add_subdirectory(common)  # disabled for WASM/' \
    -e 's/add_subdirectory(builder)/# add_subdirectory(builder)  # disabled for WASM/' \
    -e 's/add_subdirectory(filter)/# add_subdirectory(filter)  # disabled for WASM/' \
    -e 's/add_subdirectory(interpolate)/# add_subdirectory(interpolate)  # disabled for WASM/' \
    -e 's/${KENLM_LM_COMMON_SOURCE}//' \
    "$LM_CMAKELISTS"
  echo "  Patched lm/CMakeLists.txt: removed common/builder/filter/interpolate"
fi

# ---------- download boost headers (header-only, no compiled libs) ----------
BOOST_DIR="$BUILD_DIR/boost"
if [ ! -d "$BOOST_DIR/boost" ]; then
  echo "Downloading Boost headers (header-only)..."
  BOOST_VERSION="1.87.0"
  BOOST_UNDERSCORE="1_87_0"
  BOOST_URL="https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BOOST_UNDERSCORE}.tar.gz"

  mkdir -p "$BOOST_DIR"
  # Download only — we just need the headers
  curl -L "$BOOST_URL" 2>/dev/null | tar xz -C "$BOOST_DIR" --strip-components=1 \
    "boost_${BOOST_UNDERSCORE}/boost"
  echo "  Boost ${BOOST_VERSION} headers downloaded"
else
  echo "  Boost headers found at $BOOST_DIR"
fi

# ---------- build kenlm static libraries with emscripten ----------
echo "Building KenLM static libraries with Emscripten..."
KENLM_BUILD="$BUILD_DIR/kenlm-build"
rm -rf "$KENLM_BUILD"
mkdir -p "$KENLM_BUILD"

emcmake cmake -S "$KENLM_DIR" -B "$KENLM_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DKENLM_MAX_ORDER=6 \
  -DBUILD_TESTING=OFF \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBoost_INCLUDE_DIR="$BOOST_DIR" \
  -DBoost_NO_SYSTEM_PATHS=ON \
  2>&1

# Build only the core libraries (kenlm + kenlm_util), not executables
emmake make -C "$KENLM_BUILD" -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" kenlm kenlm_util 2>&1

# ---------- compile wrapper → wasm ----------
echo "Compiling WASM wrapper..."
mkdir -p "$OUTPUT_DIR"

emcc "$SCRIPT_DIR/kenlm_wrapper.cc" \
  -o "$OUTPUT_DIR/kenlm.js" \
  -I"$KENLM_DIR" \
  -I"$BOOST_DIR" \
  -L"$KENLM_BUILD/lib" \
  -lkenlm -lkenlm_util \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sMAXIMUM_MEMORY=2147483648 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createKenLM \
  -sEXPORTED_FUNCTIONS='["_kenlm_load","_kenlm_state_size","_kenlm_bos_state","_kenlm_null_state","_kenlm_score_word","_kenlm_is_oov","_kenlm_order","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8","FS","HEAPU8"]' \
  -sFILESYSTEM=1 \
  -sENVIRONMENT=worker \
  -DKENLM_MAX_ORDER=6 \
  -O3 -flto \
  -std=c++17 \
  2>&1

echo ""
echo "Build complete!"
echo "  $OUTPUT_DIR/kenlm.js   ($(wc -c < "$OUTPUT_DIR/kenlm.js" | tr -d ' ') bytes)"
echo "  $OUTPUT_DIR/kenlm.wasm ($(wc -c < "$OUTPUT_DIR/kenlm.wasm" | tr -d ' ') bytes)"
echo ""
echo "Next steps:"
echo "  1. Download lm_6.kenlm from google/medasr on HuggingFace"
echo "  2. Place it at plugin-bundles/medasr/models/lm_6.kenlm"
echo "  3. Run 'pnpm package:medasr-plugin' to create an importable bundle"
