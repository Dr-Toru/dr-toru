# Dr. Toru Project Spec

## Summary

Dr. Toru is a local-first medical dictation app built with Tauri.
The app uses medical ASR for baseline transcription and an optional local LLM pass for text transforms.
For v1, the LLM is user-provided via imported `.llamafile`.
Transcript data is treated as a session bundle with source and derived artifacts.

## Goals

- Make installation and setup simple for non-technical users.
- Keep transcription fully local by default.
- Support older hardware with graceful fallback behavior.
- Ship initial targets for macOS, Windows, and iOS.
- Keep Linux support available if maintenance cost stays low.

## Non-Goals (v1)

- Cloud inference or managed remote model hosting.
- Bundling a multi-GB LLM in the main app installer.
- Complex enterprise deployment tooling.

## Product Decisions (v1)

- LLM delivery: in-app import of a single `.llamafile`.
- Model storage: per-user app data directory.
- ASR experience uses chunking to provide a semi-real-time transcription effect.
- Show a splash screen while ASR model loading completes.
- Treat each dictation as a session bundle containing related artifacts.
- Use versioned transcript editing with autosave and active-version tracking.
- Keep LLM as an optional background service for text transforms.
- Run transforms as a single serial queue.
- On transform failure, mark error and show helpful messaging; user can continue.
- Initial transform directions include corrected transcript and SOAP outputs as separate artifacts.

## Architecture Principles

- Keep core dictation available even when the optional LLM is not present.
- Treat imported model files as managed application assets.
- Keep LLM integration replaceable so runtime choices can evolve later.
- Preserve source artifacts and avoid destructive overwrite.
- Track provenance for derived artifacts.

## Plugin Platform v1 Contracts

- Chosen implementation model:
  - Manifest and capability contract is strict and enum-backed.
  - Registry persistence uses atomic JSON writes in app data (`plugins/registry.json`).
  - Runtime ownership boundary:
    - Main thread: orchestration and provider selection only.
    - ASR worker: ORT model load and inference.
    - Tauri backend: registry persistence and `llamafile` command execution.
- Final manifest fields:
  - `pluginId`, `name`, `version`, `kind`, `runtime`, `entrypointPath`, `sha256`, `capabilities`
  - Optional: `modelFamily`, `sizeBytes`, `license`, `installedAt`, `metadata`
- Capability taxonomy (v1):
  - `asr.stream`
  - `llm.transform.correct`
  - `llm.transform.soap`
- Compatibility rules (v1):
  - `kind=asr` must use `runtime=ort` and include `asr.stream`.
  - `kind=llm` must use `runtime=llamafile` and include at least one transform capability.
- Active-provider semantics:
  - Single active provider per role: `asr` and `transform`.
  - `asr` role is always backed by a valid plugin.
  - In current implementation, imported ONNX providers are stored but not yet selectable as active ASR runtime.
  - `transform` may be unset without affecting core dictation.
- Runtime adapter contract:
  - Unified interface: `init`, `health`, `execute`, `shutdown`.
  - Concrete adapters:
    - ORT adapter for ASR worker inference.
    - Llamafile adapter for backend-managed transform execution.
- Session artifact provenance:
  - Derived artifacts must include provider/plugin provenance in artifact metadata.

## Plugin Decision Log

- Chosen:
  - Strict capability enum and compatibility matrix for predictable gating.
  - JSON registry for inspectable local-first state and atomic recovery.
  - ORT in worker and `llamafile` in backend to isolate heavy compute and process control.
- Rejected:
  - Free-form capabilities in v1 (too easy to drift and silently break gating).
  - In-memory-only registry (state loss and no auditability).
  - Backend ownership of ORT (would duplicate existing worker path and regress responsiveness).

## Plugin Dependency Map

- Manifest and capability contract unblocks:
  - Import validation
  - Feature gating
  - Adapter selection
- Registry and active-provider rules unblock:
  - Settings provider controls
  - Startup runtime resolution
  - Safe fallback handling
- Adapter contract and ownership map unblock:
  - Runtime lifecycle control
  - Shared execute flow across ORT and `llamafile`
  - Transform pipeline handoff work

## Plugin Integration Sequence

1. Finalize contract and validation.
2. Land registry persistence and discovery APIs.
3. Wire active ASR runtime resolution from registry.
4. Wire transform runtime execution through adapter interface.
5. Add import UX and provider controls on settings screen.

## Installer and Platform Plan

- Use standard Tauri packaging for each platform.
- Produce native installers per OS target:
  - macOS: `.app` / `.dmg`
  - Windows: `.msi` or NSIS `.exe`
  - iOS: app target via Tauri mobile flow
  - Linux: `.AppImage` / `.deb` (best effort)
- Main installer does not include model weights.
- Model is added later through app import flow.

## Security and Privacy Requirements

- Offline-first behavior: no required external network calls for core dictation.
- Keep model processing local to the device.
- Provide a visible Offline Mode in product settings.
- Document privacy behavior in plain language for end users.

## UX Requirements

- On first run:
  - Detect if model exists.
  - If missing, offer `Import model` or `Skip for now`.
- Provide clear model state in settings:
  - Installed or not installed
  - Basic model details
- Surface a clear warning when enhancement is disabled.
- Keep transcription as the primary UI focus.
- Open to transcription view after ASR is ready.
- Design peripheral utilities so they can appear only when model capabilities are available.
- Keep list view available with search and sort.
- Keep settings available from list view.

## Reliability and Performance

- Handle cold-start and low-memory conditions gracefully.
- Keep transforms optional to protect dictation responsiveness.
- Log local runtime errors for support diagnostics.
- Never block core ASR flow on LLM unavailability.

## Current Workstreams

- `.llamafile` import and model detection flow.
- Mobile-first core UI for transcription, list, actions, and settings entry.
- Session-bundle data model for source and derived artifacts.
- LLM transform pipeline for corrected transcript and SOAP generation.
- LLM service lifecycle with manual controls and serial queue execution.
- ASR streaming quality hardening.
- Versioned editing with autosave and active-version behavior.
- List view search and sort defaults.
- Settings foundation with retention and storage controls.
- Release and QA gating for macOS, Windows, and iOS.
- Brand asset creation, including logo system and optional Dr. Toru character.

## Future Directions

- OCR-based ingestion as an optional companion feature.
- Broader configurable transform catalogs beyond SOAP and correction.
- Expanded artifact history and undo tooling.

## Platform and Form Factor Direction

- Current primary targets are macOS, Windows, and iOS.
- Linux support remains desirable when it stays low overhead.
- Default UI direction is mobile-first across platforms.
- Desktop layout should stay streamlined and tablet-like rather than dense desktop-first.

## Open Items

- Define model trust and validation policy for distributed files.
- Define minimum supported hardware baseline for ASR and transform workflows.
- Decide whether to support multiple imported model profiles in v1 or defer to v2.
- Finalize audio capture defaults and retention policy details.
- Finalize transform-source defaults and template strategy for SOAP generation.
- Confirm Linux release depth for initial launch.
