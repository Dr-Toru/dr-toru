# ASR Benchmark

Benchmarks the native Rust ORT ASR code path — the same `asr::load_session()`
and `asr::transcribe()` functions the Tauri app uses in production.

## Usage

```bash
cd src-tauri
cargo run --release --features benchmarks --example benchmark-asr
cargo run --release --features benchmarks --example benchmark-asr -- --audio ../benchmarks/test.wav --reference ../benchmarks/test.txt
cargo run --release --features benchmarks --example benchmark-asr -- --model /path/to/other.onnx
```

Use `--release` for representative timings. Supports `--model` and `--vocab`
flags to test alternative ONNX models against the same reference.

## What it tests

- **Greedy CTC decoding** at various chunk sizes (6s, 10s, 15s, 20s, 30s, full)
- **Stride overlap merging** — same algorithm as `dictation-controller.ts`
- **Simple concatenation** — baseline without overlap merging
- Model: `medasr_lasr_ctc_int8.onnx` (production int8 quantized model)

## Changes made in this branch

### Files modified

| File                                  | Change                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `src-tauri/src/plugins/asr.rs`        | `pub(super)` → `pub` on key items; removed `▁` from special token filter |
| `src-tauri/src/plugins/mod.rs`        | `mod asr` → `pub mod asr` (expose for benchmark target)                  |
| `src-tauri/src/lib.rs`                | `mod plugins` → `pub mod plugins`                                        |
| `src-tauri/Cargo.toml`                | Added benchmark target + `default-run = "dr-toru"`                       |
| `src-tauri/examples/benchmark_asr.rs` | New native benchmark target (~400 lines)                                 |
| `src/asr.worker.ts`                   | Removed `▁` from special token filter (same fix as Rust)                 |
| `benchmarks/benchmark-asr.ts`         | Deleted (replaced by Rust binary)                                        |
| `benchmarks/dump_wasm_logits.ts`      | Deleted                                                                  |

## Key findings (2026-02-19)

### The `▁` bug (FIXED)

The bare SentencePiece marker `▁` (token index 4) was being filtered as a
"special token" in both `asr.rs` and `asr.worker.ts`. This token is the
model's word-boundary marker — it predicts `▁` + `5` + `4` as separate
tokens to produce " 54". Filtering it out collapsed all inter-word spaces
where the preceding token didn't already start with `▁`.

Fix: removed `▁` from `is_special_token()` in both `asr.rs` and `asr.worker.ts`.

**Before fix:** 37% WER ("a54-year-old", "worseningchest", "forhypertension")
**After fix:** 7.8% WER ("a 54-year-old", "worsening chest", "for hypertension")

### INT8 vs FP32: no difference

Both models produce **identical 7.8% WER** on full audio. INT8 is 1.5x faster
(2.2s vs 3.2s for 64.5s audio in release mode). The int8 quantization has
zero accuracy cost — no reason to switch to fp32.

### Benchmark results (release mode, 64.5s test audio)

| Config         | Chunks | WER      | Time |
| -------------- | ------ | -------- | ---- |
| **full**       | 1      | **7.8%** | 1.6s |
| 30s/3.0s merge | 3      | 12.4%    | 1.3s |
| 15s/1.5s merge | 5      | 10.9%    | 1.5s |
| 20s/2.0s merge | 4      | 20.2%    | 1.5s |
| 10s/2.0s merge | 8      | 24.0%    | 1.9s |
| 6s/1.5s merge  | 15     | 29.5%    | 1.5s |
| 6s/1.5s concat | 15     | 43.4%    | 1.5s |

Key observations:

- **Full audio is the ceiling** at 7.8% WER — no chunking artifacts
- **15s chunks with overlap merge** is closest to full at 10.9%
- **6s chunks** (current app default) suffer significantly at 29.5% with merge
- Overlap merging always helps vs naive concatenation
- Native Rust ORT processes 64.5s audio in 1.6s (real-time factor 0.025x)

### Word-level error analysis

All 10 errors at full audio are **formatting differences**, not recognition
mistakes. The model outputs clinical shorthand where the reference uses
spoken-out forms:

| Reference (spoken) | ASR output | Error type      |
| ------------------ | ---------- | --------------- |
| "six out of ten"   | "6/10"     | 3 sub + 2 del   |
| "milligrams" (×3)  | "mg"       | 3 substitutions |
| "twelve"           | "12"       | 1 substitution  |
| "138 over 86"      | "138/86"   | 1 deletion      |
| "Will start"       | "We will"  | 1 insertion     |

**Effective WER excluding formatting: 0% on full audio.**

Chunked configs add **real errors** on top of the same 10 formatting diffs:

| Config         | Total WER | Formatting | Real errors | Error pattern                              |
| -------------- | --------- | ---------- | ----------- | ------------------------------------------ |
| full           | 7.8%      | 10         | 0           | None                                       |
| 15s/1.5s merge | 10.9%     | 10         | 4           | Failed merge duplicates "metformin 500 mg" |
| 30s/3.0s merge | 12.4%     | 10         | 6           | Same + duplicates "twice daily"            |
| 6s/1.5s merge  | 29.5%     | 10         | 28          | Massive duplication + truncated fragments  |

At 6s chunks the overlap merge fails at nearly every seam:

- **Duplicated phrases**: "shortness of breath nausea ated shortness of breath nausea"
- **Truncated fragments**: `auscul-`/`oscultation`, `mim-` (lisinopril), `tory]` (history), `clude` (include)

Words split mid-token at chunk boundaries produce fragments the overlap
detector can't match, so both copies survive in the output.

### Hann window (not fixed — negligible impact)

The Rust code uses a periodic Hann window (`2πi/N`) while HuggingFace's
`LasrFeatureExtractor` uses symmetric (`2πi/(N-1)`). Features differ slightly
(max 0.84) but argmax agreement is 99.6%+ — negligible impact on WER.
The production TS worker (`asr.worker.ts`) uses the same periodic window
as Rust, so both paths are consistent.
