# LLM Document Generation

**Date:** 2026-02-19
**Status:** Ready for planning

## What We're Building

SOAP note generation as the first LLM transformation feature, with the
architecture set up so progress notes, referral letters, and patient
education can be added incrementally later.

The user records a dictation, gets a transcript, then taps "Create" to
pick a document type. For now that's just SOAP. The app generates it
via the llamafile plugin and saves it as a new attachment with full
provenance.

## Why This Approach

Follow the existing patterns already in the codebase:

- **Rust-side action prompts** -- The llamafile module already dispatches
  by action name (`"soap"` has a default prompt, others fall back to
  grammar correction). We add more action cases for each doc type.

- **New attachment kinds** -- The domain model uses typed `AttachmentKind`
  values (`transcript_raw`, `context_note`, etc.) with provenance tracking.
  Generated documents follow the same pattern with kinds like `soap_note`.

- **Slide-up sheet UI** -- Ported from the previous Python/PWA project.
  Create button in the recording view opens a sheet with template buttons.
  Start with just SOAP, expand the sheet as new doc types are added.

- **Batch (non-streaming)** -- The existing `plugin_runtime_llamafile_execute`
  command returns the full result. Show a spinner during generation. Streaming
  can be added later if needed.

## Key Decisions

1. **SOAP first, expand later** -- Don't build all doc types at once. Get
   SOAP working end-to-end, then add progress/referral/education as
   incremental additions.

2. **Rust owns prompt templates** -- Action prompts live in `llamafile.rs`
   alongside the existing `"soap"` case. TS can override via the `prompt`
   parameter if needed.

3. **One attachment kind per doc type** -- `soap_note`, `progress_note`,
   `referral_letter`, `patient_education`. Consistent with the existing
   specific-kind pattern.

4. **No streaming for v1** -- Batch generation with loading indicator.
   Keeps the implementation simple and matches the current execute interface.

5. **Provenance tracking** -- Each generated document links back to its
   source transcript via `sourceAttachmentId`, using `createdBy: "llm"`.

## Scope for First Pass (SOAP Only)

### Rust changes

- Expand SOAP prompt in `llamafile.rs` with better medical formatting
  instructions (the current one is just "Convert the note into SOAP format")

### Domain changes

- Add `soap_note` to `AttachmentKind`
- Add save/load helpers in `RecordingService`

### UI changes

- Add "Create" button to recording view
- Build slide-up sheet with SOAP template button
- Show generation spinner/overlay
- Display generated SOAP as a card in the recording view
- Artifact detail view for full SOAP content
- Copy-to-clipboard support

### Orchestration

- New controller or method that: reads transcript + context, calls
  `pluginPlatform.runLlm("soap", input)`, saves result as attachment,
  updates UI

## Open Questions

- Should the SOAP prompt include the context note (user's typed notes)
  along with the transcript? (Previous project did this.)
- What happens if no LLM plugin is installed/running when user taps Create?
  (Probably: disable the button or show a message pointing to Settings.)

## Future Expansion

After SOAP works end-to-end, each new doc type is just:

1. Add action case + prompt in `llamafile.rs`
2. Add attachment kind in `recording.ts`
3. Add template button in the Create sheet
4. Wire up the same generate-and-save flow
