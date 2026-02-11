# Dr. Toru Project Spec (High Level)

## Summary
Dr. Toru is a local-first medical dictation app built with Tauri.
The app uses medical ASR for baseline transcription and an optional local LLM pass to improve transcript quality.
For v1, the LLM is user-provided via imported `.llamafile`.

## Goals
- Make installation and setup simple for non-technical users.
- Keep transcription fully local by default.
- Support older hardware with graceful fallback behavior.
- Ship first-class support for macOS and Windows.
- Keep Linux support available if maintenance cost stays low.

## Non-Goals (v1)
- Cloud inference or managed remote model hosting.
- Bundling a multi-GB LLM in the main app installer.
- Complex enterprise deployment tooling.

## Product Decisions (v1)
- LLM delivery: in-app import of a single `.llamafile`.
- Model storage: per-user app data directory.
- ASR experience uses chunking to provide a semi-real-time transcription effect.
- Enhancement mode: optional post-processing step after ASR.
- Fallback: if LLM fails or times out, return raw ASR transcript.

## Architecture Principles
- Keep core dictation available even when the optional LLM is not present.
- Treat imported model files as managed application assets.
- Keep LLM integration replaceable so runtime choices can evolve later.
- Separate user experience decisions from low-level runtime decisions.

## Installer and Platform Plan
- Use standard Tauri packaging for each platform.
- Produce native installers per OS target:
  - macOS: `.app` / `.dmg`
  - Windows: `.msi` or NSIS `.exe`
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
- Design peripheral utilities so they can appear only when model capabilities are available.

## Reliability and Performance
- Handle cold-start and low-memory conditions gracefully.
- Keep enhancement optional to protect dictation responsiveness.
- Log local runtime errors for support diagnostics.
- Never block core ASR flow on LLM unavailability.

## Speculative Directions
- Transcript-focused improvements:
  - Transcript enhancement and error correction utilities.
- Clinical output utilities:
  - SOAP note generation.
  - Configurable transforms from transcript to structured outputs.
- Input expansion:
  - OCR-based ingestion as an optional companion feature.

These are design affordances rather than near-term commitments.
The product should leave room for these capabilities without making them required for the core dictation flow.

## Platform and Form Factor Direction
- Current primary targets are macOS and Windows.
- Linux support is desirable when it remains low overhead.
- iOS priority is still an open product question.
- Default UI direction is mobile-first across platforms.
- Desktop layout should stay streamlined and tablet-like rather than dense desktop-first.

## Open Items
- Define model trust and validation policy for distributed files.
- Define minimum supported hardware baseline for enhanced mode.
- Decide whether to support multiple imported model profiles in v1 or defer to v2.
- Confirm whether iOS is a primary target or a secondary track.
