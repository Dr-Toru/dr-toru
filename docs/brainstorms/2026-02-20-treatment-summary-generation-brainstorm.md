# Treatment Summary Generation

**Date:** 2026-02-20
**Status:** Ready for planning

## What We're Building

A "Treatment Summary" document type -- the second LLM generation feature
after SOAP notes. This produces a structured clinical letter summarizing a
patient's treatment course, suitable for doctor-to-doctor correspondence
(referrals, handoffs, care coordination).

The output follows the structure of a Japanese-style referral letter
(紹介状) but written in English:

1. **Greeting** -- professional salutation ("Dear Colleague,")
2. **Patient relationship** -- how the patient is known to the author
   (e.g. "This patient has been followed at our clinic since...")
3. **Clinical problem and needs** -- what's going on and what's being
   requested (e.g. "...presenting with X. We are requesting additional
   examinations for...")
4. **Medication / treatment notes** -- relevant meds, what was or wasn't
   prescribed and why
5. **Closing** -- polite professional sign-off

The recipient is generic/unspecified ("Dear Colleague" style) so it
works for any referral context without needing named recipient info.

## Why This Approach

This follows the exact expansion path laid out in the original
brainstorm (`2026-02-19-llm-document-generation-brainstorm.md`):

1. Add action case + prompt in `llamafile.rs`
2. Add attachment kind in `recording.ts` (and `storage.rs`)
3. Add a tab in the recording view UI
4. Wire up the same generate-and-save flow

No architectural changes needed. The SOAP generation pipeline is
reused as-is -- only the action name, prompt, attachment kind, and
UI surface change.

### UI approach

The Treatment Summary gets its own tab alongside the existing Context
and SOAP tabs. This keeps each document type cleanly separated and
follows the same pattern SOAP established.

## Key Decisions

1. **Name: "Treatment Summary"** -- not "Referral Letter" or "Clinical
   Letter." Closer to the Japanese 治療経過についての自由記載 concept.
   Attachment kind: `treatment_summary`.

2. **Structured English letter** -- mirrors the Japanese 紹介状 format
   (greeting, patient context, problem, meds, closing) but in natural
   English. Not free-form prose.

3. **Generic recipient** -- "Dear Colleague" style. No need for the user
   to specify a recipient name. The LLM should not invent names.

4. **Own tab** -- separate "Summary" tab in the recording view, parallel
   to SOAP. Own generate button, own copy button.

5. **Same pipeline** -- `platform.runLlm("treatment_summary", input)`
   with Rust-side default prompt. No streaming, same batch approach,
   same provenance tracking.

6. **No arch changes** -- this is purely additive. No refactoring, no
   cleanups, no changes to existing SOAP behavior.

## Scope

### Rust changes

- Add `"treatment_summary"` case in `default_llamafile_prompt()` in
  `llamafile.rs` with the structured letter prompt

### Domain changes

- Add `treatment_summary` to `AttachmentKind` in `recording.ts`
- Add `TreatmentSummary` variant to Rust `AttachmentKind` in `storage.rs`

### UI changes

- Add "Summary" tab alongside Context and SOAP
- Add treatment summary content panel and blank state
- Add generate button for treatment summary
- Add copy button for treatment summary
- Add processing overlay (or reuse SOAP's)

### Controller changes

- Add `generateTreatmentSummary()` method following same pattern as
  `generateSoapNote()`
- Add load/render for existing treatment summaries on route open
- Clear treatment summary state on re-recording (same as SOAP)

## Open Questions

None -- the pattern is well-established from SOAP.
