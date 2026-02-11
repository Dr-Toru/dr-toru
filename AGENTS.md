# Overview

Dr. Toru is a local-first medical dictation app built with Tauri. The app uses medical ASR for baseline transcription and an optional local LLM pass for various text transforms.

# Stack
- Frontend: Vite + TypeScript (`/src`)
- Desktop shell: Tauri (`/src-tauri`)
- ASR runtime: `onnxruntime-web` with local model assets

# Key Architecture
- `/src/main.ts`
  - Owns UI state, mic capture, chunking, and queueing.
  - Should stay lightweight and responsive.
- `/src/asr.worker.ts`
  - Owns model loading, feature extraction, inference, and decode.
  - Heavy compute belongs here, not on main thread.
- `/src/asr-messages.ts`
  - Single source of truth for main-thread and worker message contracts.
  - Do not duplicate message types elsewhere.
- `/public/models` and `/public/ort`
  - Bundled ASR model + ORT wasm assets.

# GitHub Issues Cheatsheet (requires sandbox escalation)
- `gh issue list`
- `gh issue list --search "query"`
- `gh issue view {<number> | <url>}`
