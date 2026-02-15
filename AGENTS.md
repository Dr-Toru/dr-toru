# Dr. Toru

Offline-first medical dictation app built on Tauri + Vite/TypeScript.

## Concept

Dr. Toru is a modular shell. The core provides a recording-oriented UI,
audio capture, and local storage. All other capabilities -- ASR, language
models, OCR -- are imported by the user as **plugins**. The app ships with
a built-in ASR plugin (MedASR) so transcription works out of the box.

### Plugins

A plugin is a directory containing a manifest and one or more asset files
(model weights, a llamafile binary, etc.). The manifest declares a **kind**
that tells the shell what the plugin does and how to run it:

- `asr` -- speech recognition (currently via onnxruntime-web in a Web Worker)
- `llm` -- text transforms such as SOAP conversion (currently via llamafile
  as a Rust-managed child process)
- Future kinds: `ocr`, etc.

Only one plugin per kind is active at a time.

Plugins can span both sides of the stack. Web-side code (`src/plugins`)
owns manifest loading, provider selection, and runtime adapters. Rust-side
code (`src-tauri/src/plugins.rs`) owns persistent storage, file import,
and process-managed runtimes like llamafile.

### Recordings

A **recording** is the atomic unit of data -- one dictation event and
everything derived from it. Each recording is a directory containing
**attachments**:

| Attachment                          | Source     |
| ----------------------------------- | ---------- |
| Captured audio                      | mic        |
| Raw transcript                      | ASR plugin |
| Revised transcript, SOAP note, etc. | LLM plugin |

Attachments track provenance so the UI can show the chain from raw audio
to final clinical note. New attachment types follow the same pattern.

### Platform

Tauri is the primary target. Storage and plugin import go through Rust
invoke commands. For web-only dev, noop/in-memory stores keep the frontend
runnable without the Rust backend.

## Stack

- Frontend: Vite + TypeScript (vanilla, no framework)
- Desktop shell: Tauri 2
- ASR runtime: onnxruntime-web (WASM, Web Worker)
- LLM runtime: llamafile (child process, HTTP)

## Key entry points

| Area                    | Web                               | Rust                       |
| ----------------------- | --------------------------------- | -------------------------- |
| UI shell and routing    | `src/main.ts`                     | --                         |
| Dictation orchestration | `src/app/dictation-controller.ts` | --                         |
| Plugin system           | `src/plugins/`                    | `src-tauri/src/plugins.rs` |
| Recording storage       | `src/app/recording-service.ts`    | `src-tauri/src/storage.rs` |
| ASR inference           | `src/asr.worker.ts`               | --                         |
