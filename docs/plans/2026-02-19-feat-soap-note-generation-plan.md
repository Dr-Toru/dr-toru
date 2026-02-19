---
title: "feat: SOAP Note Generation"
type: feat
date: 2026-02-19
---

# SOAP Note Generation

## Overview

Add SOAP note generation: user taps a "SOAP Note" button in the
recording view, the LLM generates it via llamafile, the result is saved
as an attachment with provenance, and displayed inline.

## Proposed Solution

- **Rust**: Improve SOAP prompt, raise `n_predict`/`max_tokens` globally
- **Domain**: Add `soap_note` to `AttachmentKind`
- **Service**: Make `saveAttachmentText`/`loadAttachmentText` public with
  full parameters (role, sourceAttachmentId) instead of per-kind methods
- **Controller**: Add generation to `RecordingViewController`
- **UI**: Direct "SOAP Note" button (no sheet), full content display

## Changes

### 1. Domain: Add `soap_note` attachment kind

**`src/domain/recording.ts`**

```typescript
export type AttachmentKind =
  | "transcript_raw"
  | "transcript_corrected"
  | "audio_capture"
  | "context_note"
  | "soap_note";

export type TextAttachmentKind = Extract<
  AttachmentKind,
  "transcript_raw" | "transcript_corrected" | "context_note" | "soap_note"
>;
```

**`src-tauri/src/storage.rs`** -- Add `SoapNote` variant to Rust enum
with `#[serde(rename_all = "snake_case")]` (already on the enum).

### 2. Service: Make attachment helpers public and generic

**`src/app/recording-service.ts`**

Instead of adding `saveSoapNote`/`loadSoapNote`, extend and expose the
existing private helpers:

```typescript
async saveAttachmentText(opts: {
  recordingId: string;
  attachmentId?: string | null;
  kind: TextAttachmentKind;
  createdBy: AttachmentCreator;
  text: string;
  setActive: boolean;
  role?: "source" | "derived";          // NEW, defaults to "source"
  sourceAttachmentId?: string | null;   // NEW, defaults to null
}): Promise<{ attachmentId: string }>
```

Make `loadAttachmentText` public too (or add a
`loadAttachmentByKind(recordingId, kind)` public method).

This handles SOAP notes, and any future doc type, with zero new methods.
Existing callers (`saveTranscript`, `saveContext`) are unaffected since
the new params have defaults.

Regeneration: if a `soap_note` attachment already exists, overwrite in
place (same as existing transcript behavior).

### 3. Rust: Improve SOAP prompt and raise token limit

**`src-tauri/src/plugins/llamafile.rs`**

#### 3a. Better SOAP prompt

```rust
fn default_llamafile_prompt(action: &str) -> String {
    match action {
        "soap" => concat!(
            "Convert the following clinical note into SOAP format.\n\n",
            "Use these section headers exactly:\n",
            "SUBJECTIVE:\n",
            "OBJECTIVE:\n",
            "ASSESSMENT:\n",
            "PLAN:\n\n",
            "Keep medical terminology accurate. ",
            "If information for a section is not available, ",
            "write \"Not documented.\" ",
            "Be concise but thorough."
        ).to_string(),
        _ => "Correct grammar and punctuation while preserving clinical meaning.".to_string(),
    }
}
```

#### 3b. Raise token limit globally (both code paths)

Change `n_predict` from 512 to 2048 in the non-v1 payload.
Add `max_tokens: 2048` to the v1 (OpenAI-compatible) payload too --
currently it has no limit, which means behavior depends on llamafile
defaults.

```rust
// Non-v1 path:
json!({ "prompt": full_prompt, "n_predict": 2048, "temperature": 0.2 })

// v1 path:
json!({ "model": "local", "messages": [...], "temperature": 0.2, "max_tokens": 2048 })
```

No action-dependent branching. 2048 is reasonable for all uses.

### 4. UI: Direct SOAP button + full content display

**`index.html`**

#### 4a. Add "SOAP Note" button to action bar

Add alongside existing Transcribe/Upload buttons in
`.transcribe-action-bar`:

```html
<button id="soapBtn" class="action-btn" disabled>
  <svg><!-- document icon --></svg>
  <span>SOAP Note</span>
</button>
```

**Button state:**

- Disabled when: no transcript, recording active, LLM not running,
  or generation in progress
- Enabled when: transcript exists, idle, LLM service running

#### 4b. SOAP note display (full content, no collapse)

Add below transcript area:

```html
<div id="soapSection" class="section-block" hidden>
  <div class="section-header">
    <span class="section-label">SOAP Note</span>
    <button class="section-action-btn" id="soapCopyBtn">Copy</button>
  </div>
  <div class="soap-content" id="soapContent"></div>
</div>
```

Show the full SOAP text. No preview/expand pattern -- SOAP notes are
short enough to display entirely. Copy button uses
`navigator.clipboard.writeText()`.

#### 4c. Processing overlay

Add processing overlay HTML to recording view (reuse existing
`.processing-overlay` CSS from `styles.css`):

```html
<div class="processing-overlay" id="soapOverlay" hidden>
  <div class="spinner"></div>
  <p>Generating SOAP note...</p>
</div>
```

Blocks interaction including navigation while visible.

### 5. Controller: Generation orchestration

**`src/app/recording-view-controller.ts`**

Add to `RecordingContext`:

```typescript
interface RecordingContext {
  // ... existing fields ...
  soapAttachmentId: string | null;
  soapText: string;
}
```

Note: `generating` is a UI flag on the controller itself (like
`recording`, `toggling`, `uploading`), not on the context.

```typescript
private generating = false;

async generateSoapNote(): Promise<void> {
  if (!this.ctx || this.generating) return;

  // Guard: require transcript
  if (!this.ctx.transcript.trim()) return;
  if (!this.ctx.attachmentId) return;

  this.generating = true;
  this.showSoapOverlay();

  try {
    // Flush pending context save (await it)
    await this.flushContextSave();

    // Build combined input
    const transcript = this.ctx.transcript;
    const context = this.contextNoteEl.value.trim();
    let input = `Transcript:\n${transcript}`;
    if (context) {
      input += `\n\nClinician's Notes:\n${context}`;
    }

    // Call LLM
    const soapText = await this.platform.runLlm("soap", input);

    // Save as derived attachment
    const result = await this.recordingService.saveAttachmentText({
      recordingId: this.ctx.recordingId,
      attachmentId: this.ctx.soapAttachmentId,
      kind: "soap_note",
      createdBy: "llm",
      text: soapText,
      setActive: false,
      role: "derived",
      sourceAttachmentId: this.ctx.attachmentId,
    });

    this.ctx.soapAttachmentId = result.attachmentId;
    this.ctx.soapText = soapText;
    this.renderSoap();
  } catch (err) {
    this.onError(err, "SOAP generation");
  } finally {
    this.generating = false;
    this.hideSoapOverlay();
  }
}
```

**Guards:**

- Block navigation during generation (same pattern as recording guard)
- `generating` flag prevents double-tap
- Empty transcript and null `attachmentId` checked before proceeding
- `flushContextSave()` made async and awaited

#### Load existing SOAP on navigation

In `openRoute()`, after loading transcript and context:

```typescript
const soap = await this.recordingService.loadAttachmentByKind(
  recordingId,
  "soap_note",
);
if (soap) {
  this.ctx.soapAttachmentId = soap.attachmentId;
  this.ctx.soapText = soap.text;
  this.renderSoap();
}
```

#### Handle stale SOAP after re-recording

When `onRecordingComplete()` saves a new/updated transcript, clear the
existing SOAP display and set `soapAttachmentId` to null. The old SOAP
attachment stays on disk but the user sees it's gone and can regenerate.
This avoids showing a SOAP note that doesn't match the current transcript.

## Acceptance Criteria

- [x] `soap_note` added to `AttachmentKind` (TS and Rust)
- [x] `saveAttachmentText` made public with `role` and `sourceAttachmentId` params
- [x] `loadAttachmentByKind` method available publicly
- [x] SOAP prompt in `llamafile.rs` produces structured S/O/A/P output
- [x] `n_predict` raised to 2048 globally; `max_tokens` added to v1 path
- [x] SOAP button visible and enabled only when preconditions met
- [x] Processing overlay shown during generation, blocks interaction
- [x] Generated SOAP note displayed in full below transcript
- [x] Copy button copies SOAP text to clipboard
- [x] Existing SOAP note loads when navigating to a recording
- [x] Regenerating overwrites the existing SOAP attachment
- [x] SOAP cleared when transcript changes (re-recording)
- [x] Navigation blocked during generation
- [x] Errors handled via existing `onError` callback (toast)

## Files Changed

| File                                   | Change                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/domain/recording.ts`              | Add `soap_note` to `AttachmentKind` and `TextAttachmentKind`                                                |
| `src-tauri/src/storage.rs`             | Add `SoapNote` variant to Rust enum                                                                         |
| `src/app/recording-service.ts`         | Make `saveAttachmentText` public with `role`/`sourceAttachmentId` params; add public `loadAttachmentByKind` |
| `src-tauri/src/plugins/llamafile.rs`   | Expand SOAP prompt; raise `n_predict` to 2048; add `max_tokens` to v1 path                                  |
| `src/app/recording-view-controller.ts` | Add SOAP state to context; add `generateSoapNote()`; load SOAP in `openRoute()`; clear SOAP on re-record    |
| `index.html`                           | Add SOAP button, SOAP display section, processing overlay                                                   |
| `src/styles.css`                       | Style SOAP content section                                                                                  |
| `src/main.ts`                          | Wire SOAP button click handler                                                                              |

## References

- Brainstorm: `docs/brainstorms/2026-02-19-llm-document-generation-brainstorm.md`
- Processing overlay CSS: `src/styles.css:760-786`
- Llamafile execute: `src-tauri/src/plugins/llamafile.rs:341-410`
- Recording domain: `src/domain/recording.ts:8-28`
- Recording service: `src/app/recording-service.ts:138-197`
- Recording view controller: `src/app/recording-view-controller.ts:30-36`
