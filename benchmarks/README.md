# ASR Benchmark

Benchmarks the native Rust ORT ASR code path at various chunk sizes
with and without stride-overlap merging.

## Usage

```bash
cd src-tauri
cargo run --release --features benchmarks --example benchmark-asr
cargo run --release --features benchmarks --example benchmark-asr -- \
  --audio ../benchmarks/test.wav --reference ../benchmarks/test.txt
cargo run --release --features benchmarks --example benchmark-asr -- \
  --model /path/to/other.onnx
```

Use `--release` for representative timings.
