#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$PROJECT_ROOT/plugin-bundles/medasr"
OUTPUT_PATH="${1:-$PROJECT_ROOT/dist/plugins/google-medasr-1.0.0.zip}"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command not found"
  exit 1
fi

if [ ! -f "$SOURCE_DIR/dr_toru_package.json" ]; then
  echo "missing package manifest: $SOURCE_DIR/dr_toru_package.json"
  exit 1
fi

for required in \
  "models/medasr_lasr_ctc_int8.onnx" \
  "models/medasr_lasr_vocab.json" \
  "models/lm_6.kenlm" \
  "kenlm/kenlm.js" \
  "kenlm/kenlm.wasm"; do
  if [ ! -f "$SOURCE_DIR/$required" ]; then
    echo "missing bundle asset: $SOURCE_DIR/$required"
    exit 1
  fi
done

mkdir -p "$(dirname "$OUTPUT_PATH")"

(
  cd "$SOURCE_DIR"
  zip -q -r "$OUTPUT_PATH" \
    dr_toru_package.json \
    models \
    kenlm
)

echo "wrote plugin bundle: $OUTPUT_PATH"
