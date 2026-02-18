# Context Textarea for Recording Screen

**Date:** 2026-02-16
**Status:** Ready for planning

## What We're Building

A user-editable context textarea on the recording screen, positioned above the
transcript. This is where clinicians add free-form notes (patient info, chief
complaint, observations) that get combined with the transcript to generate
artifacts like SOAP notes. The pipeline is: `(transcript + context) -> artifacts`.

This mirrors the `user_notes` concept from the previous Python API exploration,
where context was stored per-session and combined with the transcript during
enhancement/SOAP generation.

## Why This Approach

The transcript alone (raw ASR output) often lacks the clinical context needed to
produce good artifacts. A clinician observes things that aren't spoken aloud —
vitals, visual findings, patient history from the chart. The context field gives
them a place to capture these notes alongside the dictation, and the system can
then combine both inputs when generating documents.

## Key Decisions

- **Position: Above the transcript.** Follows clinical documentation order —
  context first (who is this patient, what brings them in), then the transcript
  of what was said. The clinician sees their notes at the top and the growing
  transcript below.

- **Always editable.** The context field stays writable even during recording.
  Clinicians naturally jot notes while also dictating — locking the field during
  recording would fight their real workflow.

- **Card-style visual.** The context area is a bordered card with a label header,
  visually distinct from the transcript's document-style feel. This makes it
  clear which area is user-written vs machine-generated.

- **Storage: New attachment kind.** Add `"context_note"` to `AttachmentKind` in
  the domain model and store context as a text attachment on the recording. This
  follows the existing attachment pattern exactly — same provenance tracking,
  same storage operations, no architectural changes. The creator would be `"user"`.

- **Auto-save.** Context should save automatically (debounced) as the user types,
  same way you'd expect a notes field to work. No explicit save button.

- **Incremental, no architecture changes.** Working within the existing recording
  - attachment model. The Rust storage layer already supports writing text
    attachments — we just need a new kind.

## Open Questions

- Placeholder text for the context field — something like "Add clinical context..."
  or more specific guidance?
- Should the context expand as the user types (auto-grow), or have a fixed height
  with scroll?
- When loading an existing recording, how prominent should the context be if it's
  empty vs populated?
