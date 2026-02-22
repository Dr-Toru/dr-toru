---
title: "fix: Kotoba upload drops transcript chunks"
type: fix
date: 2026-02-22
---

# fix: Kotoba upload drops transcript chunks

## Overview

When uploading an audio file for transcription using a custom imported kotoba
(Whisper) ASR plugin, only a partial transcript is produced — the output cuts
off early. This always reproduces. Live dictation (mic recording) works fine
because VAD segments are small enough to avoid the underlying issue.

## Problem Statement

The upload transcription path sends the **entire decoded audio** as a single
`Float32Array` through `pluginPlatform.transcribe(samples)`. For native ASR
plugins (anything that isn't the built-in MedASR/ort-ctc), this routes through
`NativeAsrRuntimeAdapter.execute()`, which does:

```typescript
// src/plugins/runtime-adapter.ts:241-244
return invoke<RuntimeExecuteResult>("plugin_asr_transcribe", {
  pluginId: this.pluginId,
  samples: Array.from(request.samples), // ← converts Float32Array to number[]
});
```

**Two compounding problems:**

### 1. Massive JSON payload via Tauri IPC

`Array.from(Float32Array)` produces a JavaScript `number[]` that Tauri
serializes to JSON. A 5-minute audio file at 16kHz = 4,800,000 float samples.
Each float serializes to ~10-15 JSON characters, producing **~50-70MB of JSON**
for the IPC message. Tauri's JSON-based `invoke()` has practical limits on
message size, and large payloads can be silently truncated, causing the Rust
side to receive fewer samples than expected.

### 2. No chunking for uploaded files

Live dictation naturally avoids this because the VAD segmenter breaks audio
into small chunks (a few seconds each), each well within IPC limits. But the
upload path sends everything at once — there's no chunking layer for uploaded
files.

**Why built-in MedASR is unaffected:** It uses `OrtRuntimeAdapter` which
passes samples directly to the web worker via `postMessage()` with
`ArrayBuffer` transfer — binary, no JSON serialization, no size limits.

## Root Cause

```
Upload file
  → decodeAudioFileToSamples() → full Float32Array (millions of samples)
  → pluginPlatform.transcribe(samples)
  → NativeAsrRuntimeAdapter.execute()
  → Array.from(samples)  ← creates massive number[]
  → invoke("plugin_asr_transcribe", { samples: [...] })
  → Tauri JSON serializes ~50MB+ of numbers
  → Rust receives truncated Vec<f32>
  → Whisper transcribes only what it received → partial transcript
```

## Proposed Solution

**Chunk uploaded audio on the frontend before sending to the ASR runtime.**
This mirrors what live dictation already does (VAD segmenter → small chunks →
transcribe each → merge results) but with fixed-size chunks instead of
VAD segments.

This approach:

- Fixes the IPC size issue (each chunk is small)
- Works for both native and web worker ASR runtimes
- Reuses the existing `mergeChunkText()` overlap-merge logic
- Keeps the fix entirely in TypeScript (no Rust changes)
- Matches the benchmark tool's proven chunking strategy

### Implementation

#### Phase 1: Extract chunk utilities

Create `src/audio/chunk.ts` with two functions extracted/adapted from
`DictationController` and the benchmark tool:

```typescript
// src/audio/chunk.ts

const DEFAULT_CHUNK_SECS = 20;
const DEFAULT_STRIDE_SECS = 2;

/**
 * Split audio samples into overlapping chunks for sequential transcription.
 * Uses fixed-size windows (not VAD) since we have the complete audio upfront.
 */
export function chunkAudio(
  samples: Float32Array,
  sampleRate: number,
  chunkSecs = DEFAULT_CHUNK_SECS,
  strideSecs = DEFAULT_STRIDE_SECS,
): Float32Array[] {
  const chunkLen = Math.floor(chunkSecs * sampleRate);
  if (chunkLen >= samples.length) {
    return [samples];
  }
  const strideLen = Math.floor(strideSecs * sampleRate);
  const stepLen = chunkLen - strideLen;
  const chunks: Float32Array[] = [];
  let offset = 0;
  while (offset < samples.length) {
    const end = Math.min(offset + chunkLen, samples.length);
    chunks.push(samples.subarray(offset, end));
    if (end >= samples.length) break;
    offset += stepLen;
  }
  return chunks;
}
```

Chunk sizes: **20s chunks with 2s stride** — matches the benchmark's
best-performing config for Whisper models, and keeps each IPC payload under
~2.5MB of JSON (manageable).

#### Phase 2: Modify `transcribeUploadedFile` to chunk and merge

In `src/main.ts`, change the upload transcription path from a single call to
a chunk-iterate-merge loop:

```typescript
// src/main.ts — transcribeUploadedFile (modified)

import { chunkAudio } from "./audio/chunk";
import { mergeChunkText } from "./app/dictation-controller";

// ... inside transcribeUploadedFile:
const samples = await decodeAudioFileToSamples(file, SAMPLE_RATE);
const chunks = chunkAudio(samples, SAMPLE_RATE);

let transcript = "";
for (const chunk of chunks) {
  const text = await pluginPlatform.transcribe(chunk);
  transcript = mergeChunkText(transcript, text);
}

await recordingView.onRecordingComplete(transcript);
```

#### Phase 3: Export `mergeChunkText` from dictation-controller

`mergeChunkText` is already a standalone function in
`src/app/dictation-controller.ts:281`. It just needs to be exported (it
already is — `export function mergeChunkText`). No changes needed here.

### Files to change

| Action | File                      | Purpose                                  |
| ------ | ------------------------- | ---------------------------------------- |
| Create | `src/audio/chunk.ts`      | `chunkAudio()` utility                   |
| Modify | `src/main.ts`             | Chunk uploaded audio before transcribing |
| Test   | `src/audio/chunk.test.ts` | Unit tests for chunking logic            |

## Acceptance Criteria

- [ ] Uploading a 5+ minute audio file with kotoba plugin produces a complete
      transcript (not truncated)
- [x] Short audio files (< 20s) still work correctly (single chunk, no
      overhead)
- [x] `chunkAudio()` produces overlapping windows with correct boundaries
- [x] `mergeChunkText()` properly deduplicates overlap regions between chunks
- [ ] Built-in MedASR upload transcription still works (regression check)
- [ ] Live dictation still works normally (no changes to that path)
- [x] Unit tests cover edge cases: empty audio, exactly chunk-sized audio,
      audio shorter than one chunk, audio with remainder less than stride

## Technical Considerations

- **Chunk size trade-off:** Larger chunks = fewer IPC calls + better context
  for the model, but larger JSON payloads. 20s at 16kHz = 320,000 floats ≈
  2.5MB JSON — safe for Tauri IPC. The benchmark tool shows 20s/2s produces
  good WER scores.
- **Future optimization:** If IPC size remains a concern, a more robust fix
  would be writing samples to a temp file and passing the path to Rust.
  However, chunking is the simpler fix and also improves transcript quality
  for long files (Whisper's attention degrades on very long sequences even
  though whisper.cpp does internal 30s windowing).
- **No Rust changes needed.** The Rust side already handles `Vec<f32>` of
  any size; it's the JSON serialization layer that truncates.

## References

- Upload entry point: `src/main.ts:1047` (`transcribeUploadedFile`)
- Native ASR adapter: `src/plugins/runtime-adapter.ts:235` (`NativeAsrRuntimeAdapter.execute`)
- Benchmark chunking: `src-tauri/src/bin/benchmark_asr.rs:179` (`chunk_audio`)
- Merge logic: `src/app/dictation-controller.ts:281` (`mergeChunkText`)
- Audio decode: `src/audio/upload.ts:1` (`decodeAudioFileToSamples`)
- [Whisper 30s context window](https://github.com/ggml-org/whisper.cpp/discussions/206)
- [Whisper long-form transcription](https://medium.com/@yoad/whisper-long-form-transcription-1924c94a9b86)
