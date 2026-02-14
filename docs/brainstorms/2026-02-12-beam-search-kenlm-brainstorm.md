# Beam Search Decoding + 6-gram KenLM Language Model

**Date:** 2026-02-12
**Status:** Ready for planning
**Related:** Issue #6 (ASR streaming quality)

## What We're Building

Replace the current greedy CTC decoder (`decodeCTC` in `asr.worker.ts`) with a CTC prefix beam search decoder that uses a 6-gram KenLM language model for rescoring. This targets a ~25% WER improvement (matching results from the Python/Transformers reference implementation).

**Components:**
1. **KenLM compiled to WASM** — loaded in the web worker alongside the ONNX model
2. **Minimal CTC prefix beam search** — ~150-200 lines of TypeScript in the worker
3. **`lm_6.kenlm` from `google/medasr`** — the official pre-trained 6-gram LM, bundled in `public/models/`
4. **Revised chunking parameters** — revisit the current 4s/1s chunk/stride to potentially benefit from longer context with beam search

## Why This Approach

**KenLM WASM + minimal TS beam search** was chosen over pure-TS n-gram scoring (too slow, subtle to implement correctly) and Rust/Tauri sidecar (breaks the web-worker architecture).

Rationale:
- KenLM is battle-tested and fast even when compiled to WASM via Emscripten
- Keeps all heavy compute in `asr.worker.ts` per AGENTS.md guidance
- The `decodeCTC` function is an isolated replacement target — same inputs (logits, dims, vocab), same output (string)
- Uses the official `lm_6.kenlm` binary from HuggingFace as-is
- Beam width is configurable for performance tuning (start at 8, matching the Python reference)

## Key Decisions

1. **Runtime: WASM (not native, not pure TS)** — KenLM compiled to WASM via Emscripten, loaded in the web worker. One-time build step, but gives compiled C++ performance in the browser.

2. **Beam search: custom minimal implementation** — Not porting pyctcdecode wholesale. Write a focused CTC prefix beam search in TypeScript that calls KenLM WASM for LM scoring. Tailored to MedASR's 613-token SentencePiece vocab.

3. **LM artifact: `lm_6.kenlm` from `google/medasr` HuggingFace** — Pre-trained, ready to use. Bundled in `public/models/`.

4. **Chunking: revisit alongside decoder change** — Current 4s chunks with 1s stride may be suboptimal for beam search. The Python reference uses 20s/2s. Will experiment with longer chunks once beam search is in place.

5. **Performance: benchmark first, then tune** — No hard latency budget upfront. Implement beam search with beam_width=8, measure on target hardware, then adjust (beam width, chunk size, pruning thresholds).

6. **Fallback: keep greedy as an option** — The greedy decoder is fast and correct. Keep it as a fallback for low-powered hardware or as a baseline for benchmarking.

## Architecture Sketch

```
┌─────────────────── asr.worker.ts ───────────────────┐
│                                                       │
│  Audio Buffer                                         │
│      │                                                │
│      ▼                                                │
│  extractMelFeatures() → [1, T, 128]                  │
│      │                                                │
│      ▼                                                │
│  session.run() → logits [1, T, 613]                  │
│      │                                                │
│      ├──► decodeCTC()         (greedy, existing)      │
│      │                                                │
│      └──► decodeBeamSearch()  (new)                   │
│               │                                       │
│               ├── CTC prefix beam search (TS)         │
│               │       │                               │
│               │       ▼                               │
│               └── KenLM WASM module                   │
│                   ├── loadModel(lm_6.kenlm)           │
│                   └── score(prefix) → log_prob        │
│                                                       │
└───────────────────────────────────────────────────────┘
```

## SentencePiece Vocab Considerations

The MedASR vocab uses `▁` (U+2581) as word-boundary markers. The Python reference handled this by:
- Replacing `▁` with `#` for pyctcdecode compatibility
- Prefixing tokens so pyctcdecode treats them as "words"

For our minimal implementation, we need to:
- Map SentencePiece tokens to word boundaries for KenLM word-level scoring
- Handle the blank token (`<epsilon>`, id=0) and special tokens correctly in beam expansion
- Apply log-softmax to raw logits before beam scoring (currently not done in greedy)

## Open Questions

1. **KenLM WASM build** — Is there an existing Emscripten build of KenLM we can use, or do we need to build from source? What's the WASM binary size?
2. **`.kenlm` vs `.arpa` format** — Can KenLM's C++ code load the `.kenlm` binary format directly, or do we need the `.arpa` text format? (Binary is preferred for size and load time.)
3. **Bundle size impact** — The ONNX model is already 402 MB (Git LFS). How large is `lm_6.kenlm`? Combined with KenLM WASM, what's the total bundle size increase?
4. **Chunk size sweet spot** — What chunk duration maximizes accuracy without excessive latency? Need benchmarks across 4s, 8s, 12s, 20s.
5. **`mergeChunkText()` compatibility** — Does beam search output (potentially with different word boundaries) remain compatible with the existing overlap-merge logic?
6. **Streaming partial results** — Should beam search emit partial/intermediate hypotheses for real-time display, or only final results per chunk?

## Reference Implementation

The Python/Transformers version (separate repo) achieved ~25% WER improvement using:
- `pyctcdecode` wrapping a custom `LasrCtcBeamSearchDecoder`
- Beam width of 8
- `lm_6.kenlm` 6-gram language model
- 20s chunks with 2s stride
- `▁` → `#` token mapping trick for pyctcdecode compatibility
