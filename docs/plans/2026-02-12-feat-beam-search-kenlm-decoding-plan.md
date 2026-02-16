---
title: "feat: Add beam search decoding with 6-gram KenLM language model"
type: feat
date: 2026-02-12
---

# feat: Add beam search decoding with 6-gram KenLM language model

## Overview

Replace the greedy CTC decoder in `asr.worker.ts` with a CTC prefix beam search decoder backed by a 6-gram KenLM language model compiled to WASM. Targets ~25% WER improvement over greedy decoding, matching results from the proven Python/Transformers reference implementation.

## Problem Statement / Motivation

The current `decodeCTC()` function does frame-by-frame argmax (greedy decoding) with no language model. This is fast but leaves significant accuracy on the table — the Python reference implementation achieves ~25% WER reduction by adding beam search + KenLM. For medical dictation, transcription accuracy directly impacts clinical workflows and patient safety.

## Proposed Solution

Three-phase implementation that keeps the current greedy decoder as a fallback at every stage:

1. **Phase 1 — KenLM WASM build + integration spike** (highest risk, do first)
2. **Phase 2 — CTC prefix beam search in TypeScript** (core algorithm)
3. **Phase 3 — Chunking optimization + quality evaluation** (tune and validate)

## Technical Approach

### Architecture

All new code lives in the web worker per AGENTS.md. The main thread and message protocol require minimal changes.

```
┌─────────────────────── asr.worker.ts ───────────────────────┐
│                                                               │
│  Module state (new additions marked with *)                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ session: ort.InferenceSession                        │    │
│  │ vocab: MedasrVocab                                   │    │
│  │ * kenlmModule: KenLMModule | null                    │    │
│  │ * kenlmModel: KenLMModel | null                      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  loadModel()                                                  │
│  ├── loadJsonWithCache(vocab)                                 │
│  ├── loadBinaryWithCache(onnx)                               │
│  ├── ort.InferenceSession.create(...)                        │
│  ├── * loadKenLMWasm()        → kenlmModule                  │
│  └── * loadBinaryWithCache(lm_6.kenlm)                       │
│        └── kenlmModule.FS.writeFile → kenlmModel.load()      │
│                                                               │
│  transcribe()                                                 │
│  ├── extractMelFeatures(samples) → [1, T, 128]              │
│  ├── session.run({input_features, attention_mask})            │
│  │   └── logits: [1, T, 613]                                │
│  ├── * logSoftmax(logits) → log_probs: [1, T, 613]          │
│  └── decode:                                                  │
│      ├── if kenlmModel: decodeBeamSearchLM(log_probs, ...)   │
│      ├── elif kenlmModule: decodeBeamSearch(log_probs, ...)  │
│      └── else: decodeCTC(logits, ...)  (greedy fallback)     │
│                                                               │
│  * decodeBeamSearchLM()                                       │
│  ├── Initialize beam set: [{text:"", partial:"", P_b:0, …}] │
│  ├── For each frame t:                                        │
│  │   ├── Token pruning (only tokens > exp(min_token_logp))   │
│  │   ├── For each beam × each candidate token:               │
│  │   │   ├── Blank: extend P_b                               │
│  │   │   ├── Repeat: split P_b/P_nb paths                   │
│  │   │   ├── Word boundary (▁): flush partial → KenLM score  │
│  │   │   └── Regular: accumulate in partial_word              │
│  │   ├── Merge duplicate prefixes (logsumexp)                │
│  │   └── Prune to top beam_width beams                       │
│  ├── Finalize: score remaining partial_word + EOS            │
│  └── Return best beam text                                    │
│                                                               │
│  decodeCTC()  (existing, unchanged, always available)         │
└───────────────────────────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: KenLM WASM Build + Integration Spike

**Goal:** Prove that KenLM can load and score text in a web worker via WASM. This is the highest-risk phase — if this fails, the entire approach needs reconsideration.

**Tasks:**

- [x] Download `lm_6.kenlm` from `google/medasr` on HuggingFace and measure file size (671MB)
  - If >200MB, investigate pruned/quantized alternatives before proceeding
  - Add to `public/models/lm_6.kenlm`
  - [x] Update `.gitattributes` to LFS-track `*.kenlm` files

- [x] Set up KenLM Emscripten build
  - Reference: [yhwang/ds2-tfjs](https://github.com/yhwang/ds2-tfjs) WASM build (the only known existing KenLM WASM implementation)
  - Clone KenLM source, apply Emscripten patches:
    - `secure_getenv` → `getenv` for `__EMSCRIPTEN__`
    - Double-conversion platform detection fix
    - Disable executable builds (`BUILD_EXEC=OFF`)
  - Compile with Emscripten:
    ```bash
    emcc kenlm_wrapper.cc -o kenlm.js \
      -sALLOW_MEMORY_GROWTH=1 \
      -sINITIAL_MEMORY=64MB \
      -sMAXIMUM_MEMORY=512MB \
      -sMODULARIZE=1 \
      -sEXPORT_NAME=createKenLM \
      -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
      -sFILESYSTEM=1 \
      -sENVIRONMENT=worker \
      -DKENLM_MAX_ORDER=6 \
      -O3 -flto
    ```
  - Expected output: `kenlm.wasm` (~900KB) + `kenlm.js` (~300KB)
  - Place artifacts in `public/kenlm/`

- [x] Write minimal C++ wrapper (`kenlm_wrapper.cc`)
  - Expose via `extern "C"` or Embind:
    - `loadModel(path: string, maxOrder: number) → bool`
    - `createState() → statePtr`
    - `scoreWord(statePtr, word: string) → { logProb: number, newStatePtr }`
    - `freeState(statePtr) → void`
  - Use `lm::ngram::Config` with `load_method = util::POPULATE_OR_READ`
  - Support the KenLM binary format (`.kenlm`) loaded via MEMFS

- [x] Integrate into `asr.worker.ts` load path
  - Add KenLM WASM loading after ONNX session creation
  - Use existing `loadBinaryWithCache()` for the `.kenlm` file
  - Write to MEMFS: `kenlmModule.FS.writeFile('/model.kenlm', new Uint8Array(buffer))`
  - **Graceful degradation**: If KenLM load fails, log warning and continue without LM
    ```typescript
    // asr.worker.ts loadModel()
    try {
      const createKenLM = await import("../public/kenlm/kenlm.js");
      kenlmModule = await createKenLM();
      const lmData = await loadBinaryWithCache(
        message.modelsDir + "lm_6.kenlm",
      );
      kenlmModule.FS.writeFile("/model.kenlm", new Uint8Array(lmData));
      kenlmModel = new kenlmModule.KenLMScorer();
      kenlmModel.loadModel("/model.kenlm", 6);
      postStatus("Language model loaded");
    } catch (e) {
      console.warn("KenLM load failed, using greedy fallback:", e);
      kenlmModule = null;
      kenlmModel = null;
    }
    ```

- [ ] Write a smoke test: load KenLM in a test harness, score "the patient presented with chest pain", verify a finite log-probability is returned

**Success criteria for Phase 1:**

- KenLM WASM loads in a web worker without crashing
- `scoreWord()` returns valid log-probabilities for English words
- Total load time increase is measurable and documented
- Memory overhead of KenLM (WASM + model) is measured

**Files changed:**
| File | Change |
|------|--------|
| `public/kenlm/kenlm.wasm` | New — compiled WASM binary |
| `public/kenlm/kenlm.js` | New — Emscripten JS glue |
| `public/models/lm_6.kenlm` | New — 6-gram language model binary |
| `.gitattributes` | Add `*.kenlm` LFS tracking |
| `src/asr.worker.ts` | Extend `loadModel()` with KenLM loading + graceful fallback |
| `src/asr-messages.ts` | Add optional `lmDir` field to `LoadRequest` |

---

#### Phase 2: CTC Prefix Beam Search Decoder

**Goal:** Implement the beam search algorithm in TypeScript, integrated with KenLM scoring.

**Tasks:**

- [x] Implement `logSoftmax()` utility function
  - Numerically stable: `logit[i] - log(sum(exp(logit[j] - max(logit))))` per frame
  - Applied to raw logits before beam search (greedy decoder is unaffected — argmax is invariant)
  - Operates on the full `[1, T, 613]` logits tensor in-place or returns new buffer

  ```typescript
  // src/asr.worker.ts
  function logSoftmax(
    logits: ArrayLike<number>,
    frames: number,
    vocabSize: number,
  ): Float32Array {
    const result = new Float32Array(frames * vocabSize);
    for (let t = 0; t < frames; t++) {
      const offset = t * vocabSize;
      let max = -Infinity;
      for (let v = 0; v < vocabSize; v++) {
        if (logits[offset + v] > max) max = logits[offset + v];
      }
      let sumExp = 0;
      for (let v = 0; v < vocabSize; v++) {
        sumExp += Math.exp(logits[offset + v] - max);
      }
      const logSumExp = max + Math.log(sumExp);
      for (let v = 0; v < vocabSize; v++) {
        result[offset + v] = logits[offset + v] - logSumExp;
      }
    }
    return result;
  }
  ```

- [x] Define beam data structure

  ```typescript
  interface Beam {
    text: string; // Completed, LM-scored words
    partialWord: string; // Subword tokens accumulated, not yet a complete word
    lastTokenId: number; // Last emitted token ID (for repeat detection)
    logProbBlank: number; // log P_b(t, prefix) — ends in blank
    logProbNonBlank: number; // log P_nb(t, prefix) — ends in non-blank
    lmScore: number; // Accumulated LM log-probability
    lmStatePtr: number; // KenLM state pointer (WASM heap)
    wordCount: number; // For word insertion bonus (beta)
  }
  ```

- [x] Implement `decodeBeamSearchLM()` — the core algorithm
  - **Initialization**: Single beam with empty prefix, `P_b = 0.0` (log-space), `P_nb = -Infinity`
  - **Per-frame loop** (T frames):
    1. **Token pruning**: Compute argmax token; include all tokens with `log_prob >= min_token_logp` (default -5.0)
    2. **Beam expansion**: For each beam × each pruned token:
       - **Blank token** (id=0): `new_P_b = logadd(P_b, P_nb) + log_prob[blank]`
       - **Repeated token** (same as `lastTokenId`):
         - Extend (from blank path): `new_P_nb[l+c] += P_b + log_prob[c]`
         - Collapse (from non-blank path): `new_P_nb[l] += P_nb + log_prob[c]`
       - **Word boundary** (token starts with `▁`):
         - Flush `partialWord` → complete word → `kenlmModel.scoreWord(lmState, word)` → accumulate `lmScore`
         - Start new `partialWord` with token text (minus `▁` prefix)
       - **Regular token**: Append token text to `partialWord`
    3. **Merge**: Beams with identical `(text, partialWord, lastTokenId)` → combine via `logsumexp`
    4. **Score**: `totalScore = logadd(P_b, P_nb) + alpha * lmScore + beta * wordCount`
    5. **Prune**: Keep top `beamWidth` beams by `totalScore`
  - **Finalization**: Score remaining `partialWord` via KenLM + EOS token
  - Return best beam's `text + partialWord`

- [x] Implement `logsumexp()` helper

  ```typescript
  function logsumexp(a: number, b: number): number {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const max = Math.max(a, b);
    return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
  }
  ```

- [x] Handle SentencePiece `▁` → word boundary mapping
  - Token starts with `▁` → word boundary detected
  - Flush accumulated `partialWord` to KenLM as complete word
  - Start new `partialWord` from token text (strip leading `▁`, it becomes a space in output)
  - Special case: bare `▁` token (id=4) → word boundary with no new content

- [x] Handle special tokens
  - Reuse existing `isSpecialToken()` for `<s>`, `</s>`, `<extra_id_*>`
  - Skip these during beam expansion (same as greedy decoder)

- [x] KenLM state lifecycle management
  - Each beam holds a `lmStatePtr` (pointer into WASM heap)
  - When a beam is forked (extended), copy the parent's state: `newState = kenlmModel.copyState(parentState)`
  - When a beam is pruned, free its state: `kenlmModel.freeState(beam.lmStatePtr)`
  - **Critical**: Must free all states at end of decode, including non-winning beams

- [ ] Add LM score caching (deferred to Phase 3 — beam merging handles deduplication)
  - Cache key: `(text, partialWord)` → `(lmScore, lmStatePtr)`
  - Avoids redundant KenLM queries when multiple beams converge to the same prefix
  - Clear cache per `transcribe()` call

- [x] Wire decoder selection in `transcribe()`

  ```typescript
  // src/asr.worker.ts transcribe()
  const logits = outputs.logits;
  let text: string;
  if (kenlmModel) {
    const logProbs = logSoftmax(logits.data, dims[1], dims[2]);
    text = decodeBeamSearchLM(logProbs, dims, vocabData, kenlmModel, {
      beamWidth: 8,
      alpha: 0.5,
      beta: 1.5,
      minTokenLogP: -5.0,
    });
  } else {
    text = decodeCTC(logits.data, dims, vocabData);
  }
  ```

- [x] Add decoder configuration constants
  ```typescript
  const BEAM_WIDTH = 8;
  const LM_ALPHA = 0.5; // LM weight
  const LM_BETA = 1.5; // Word insertion bonus
  const MIN_TOKEN_LOGP = -5.0; // Token pruning threshold
  const BEAM_PRUNE_LOGP = -10.0; // Beam score pruning threshold
  ```

**Success criteria for Phase 2:**

- Beam search produces text output for all test inputs without errors
- Output quality is subjectively better than greedy on sample medical dictation
- Greedy decoder still works when KenLM is unavailable (fallback path)
- No memory leaks (KenLM states properly freed after each decode)
- TypeScript compiler passes with no errors

**Files changed:**
| File | Change |
|------|--------|
| `src/asr.worker.ts` | Add `logSoftmax()`, `logsumexp()`, `decodeBeamSearchLM()`, beam types, decoder dispatch, config constants |

---

#### Phase 3: Chunking Optimization + Quality Evaluation

**Goal:** Tune parameters and validate that the feature actually improves transcription quality on medical text.

**Tasks:**

- [x] Make chunk parameters configurable
  - Extract `CHUNK_SECS`, `STRIDE_SECS` from constants in `main.ts` to configurable values
  - Allow override via `localStorage` for development tuning:
    ```typescript
    const CHUNK_SECS = Number(localStorage.getItem("toru.chunk.secs")) || 4;
    const STRIDE_SECS = Number(localStorage.getItem("toru.stride.secs")) || 1;
    ```

- [ ] Benchmark beam search latency across chunk durations
  - Test with 4s, 6s, 8s, 10s, 15s, 20s chunks
  - Measure: ONNX inference time, log-softmax time, beam search time, total time
  - Record on target hardware (specify machine specs)
  - Determine the maximum chunk duration where total processing < chunk step interval

- [ ] Verify `mergeChunkText()` compatibility
  - Test with beam search output on overlapping audio segments
  - If overlap detection fails (likely — LM causes context-dependent output):
    - Option A: Reduce stride to minimize overlap region
    - Option B: Use confidence-weighted merge (prefer center-of-chunk text)
    - Option C: Increase chunk duration enough that overlap is irrelevant

- [ ] Quality evaluation with medical dictation samples
  - Prepare 10-20 medical dictation recordings with ground truth transcriptions
  - Measure WER for: greedy, beam-only (no LM), beam+LM
  - **Gate**: If beam+LM does not improve WER on medical text, do not ship — investigate why
  - Tune alpha/beta via grid search if WER improvement is marginal:
    - Alpha: 0.1, 0.3, 0.5, 0.7, 1.0
    - Beta: 0.5, 1.0, 1.5, 2.0, 3.0

- [ ] Performance profiling and optimization
  - Profile memory usage: ONNX + KenLM combined
  - Identify if log-softmax is a bottleneck (2000 frames × 613 tokens = 1.2M exp operations)
  - If needed, optimize log-softmax with typed arrays and loop unrolling
  - Monitor GC pressure from beam object allocation

- [ ] Add debug metrics (behind `toru.debug.metrics` localStorage flag)
  - Beam width used per chunk
  - KenLM queries per decode
  - Top beam confidence (log-probability)
  - Decode time breakdown (log-softmax, beam search, KenLM scoring)

**Files changed:**
| File | Change |
|------|--------|
| `src/main.ts` | Make chunk params configurable, add debug metrics display |
| `src/asr.worker.ts` | Add timing instrumentation |

## Acceptance Criteria

### Functional Requirements

- [ ] KenLM WASM loads and scores text correctly in the web worker
- [ ] Beam search decoder produces transcriptions from audio input
- [ ] Output quality is measurably better than greedy on medical dictation (WER comparison)
- [ ] Greedy decoder is preserved as fallback when KenLM fails to load
- [ ] Three-tier degradation works: beam+LM → beam-only → greedy
- [ ] `mergeChunkText()` produces clean transcript with beam search output (no duplicates/gaps)
- [ ] Existing functionality is not broken — greedy mode still works identically

### Non-Functional Requirements

- [ ] Total chunk processing (inference + decode) completes within the chunk step interval
- [ ] No memory leaks during extended dictation sessions (>10 minutes)
- [ ] App startup time increase from KenLM loading is documented and acceptable
- [ ] KenLM WASM + `.kenlm` model bundle size is documented

## Dependencies & Risks

| Risk                                                            | Severity   | Mitigation                                                                                                      |
| --------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| KenLM WASM build fails / too complex                            | **High**   | Spike Phase 1 first. If blocked, evaluate Rust WASM alternative or pure TS n-gram scorer.                       |
| `lm_6.kenlm` is too large (>200MB)                              | **High**   | Measure immediately. If too large, investigate quantized/pruned LM or request smaller model from google/medasr. |
| KenLM binary format incompatible with WASM (endianness)         | **Medium** | Test early. If incompatible, rebuild binary using Emscripten-compiled `build_binary`.                           |
| Beam search too slow for real-time on target hardware           | **Medium** | Start with beam_width=8, reduce if needed. Token pruning (-5.0 threshold) limits candidates to ~5-20 per frame. |
| LM penalizes correct medical terminology                        | **Medium** | Tune alpha down. The `lm_6.kenlm` from google/medasr should be trained on medical text — verify.                |
| `mergeChunkText` breaks with LM-rescored output                 | **Medium** | Test early in Phase 3. May need to redesign merge strategy or reduce overlap.                                   |
| WASM memory limit hit (ONNX 402MB + KenLM model + beam buffers) | **Low**    | Monitor with `performance.memory`. Set `MAXIMUM_MEMORY=512MB` for KenLM WASM.                                   |
| Boost dependency makes Emscripten build painful                 | **Low**    | Modern KenLM has reduced Boost deps. For library-only build (no executables), Boost may be eliminable.          |

## Alternative Approaches Considered

1. **Pure TypeScript n-gram LM** — Reimplement KenLM scoring in TS. Rejected: too slow for 6-gram model, reimplementing backoff scoring correctly is subtle, and `.kenlm` binary format can't be parsed in TS.

2. **Rust Tauri sidecar** — Run beam search natively in Rust. Rejected: breaks the web-worker architecture, adds IPC latency, more complex build.

3. **Port pyctcdecode wholesale** — Translate the full Python library to TypeScript. Rejected: unnecessary complexity. The minimal implementation (~200 lines) covers our use case without the abstraction layers.

4. **sherpa-onnx WASM** — Use the Next-gen Kaldi WASM build which includes beam search. Rejected: would replace the entire ASR pipeline, not just the decoder. Overkill.

## References & Research

### Internal References

- Brainstorm: `docs/brainstorms/2026-02-12-beam-search-kenlm-brainstorm.md`
- Current greedy decoder: `src/asr.worker.ts:367-403` (`decodeCTC`)
- Worker message contracts: `src/asr-messages.ts`
- Audio chunking: `src/main.ts:13-18`, `src/audio/capture.ts`
- Chunk text merge: `src/main.ts:361-394` (`mergeChunkText`)
- Architecture guidance: `AGENTS.md`
- Related issue: #6 (Improve ASR streaming quality)

### External References

- [KenLM WASM (yhwang/ds2-tfjs)](https://github.com/yhwang/ds2-tfjs) — Only known existing KenLM WASM build
- [pyctcdecode (Kensho)](https://github.com/kensho-technologies/pyctcdecode) — Reference Python beam search + KenLM
- [CTC Prefix Beam Search Explained (Corti)](https://medium.com/corti-ai/ctc-networks-and-language-models-prefix-beam-search-explained-c11d1ee23306) — Algorithm tutorial
- [Distill.pub CTC Guide](https://distill.pub/2017/ctc/) — Authoritative CTC reference
- [Hannun CTC Decoder Gist](https://gist.github.com/awni/56369a90d03953e370f3964c826ed4b0) — Minimal reference implementation
- [google/medasr on HuggingFace](https://huggingface.co/google/medasr) — Model and LM source
- [Emscripten WASM Compilation](https://emscripten.org/docs/compiling/WebAssembly.html)
- [Emscripten Embind](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html)
