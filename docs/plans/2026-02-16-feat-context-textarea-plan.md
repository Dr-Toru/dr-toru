---
title: "feat: Add context textarea to recording screen"
type: feat
date: 2026-02-16
---

# feat: Add context textarea to recording screen

## Overview

Add a user-editable context textarea to the recording screen, positioned
above the transcript. Clinicians use this to capture free-form notes
(patient info, chief complaint, observations) that will later combine with
the transcript to generate artifacts like SOAP notes. The pipeline is:
`(transcript + context) -> artifacts`.

## Problem Statement

The transcript alone (raw ASR output) often lacks the clinical context
needed to produce good artifacts. A clinician observes things that aren't
spoken aloud -- vitals, visual findings, patient history from the chart.
There's currently no place to capture these notes alongside the dictation.

## Proposed Solution

Add a card-style textarea above the existing transcript in the recording
screen's `.view-body`. Store the context as a new `"context_note"`
attachment kind on the recording, following the existing attachment pattern
exactly. Auto-save with a debounced write as the user types.

### Key Design Decisions

| Decision          | Choice                                 | Rationale                                                      |
| ----------------- | -------------------------------------- | -------------------------------------------------------------- |
| Position          | Above transcript                       | Clinical documentation order -- context first, then transcript |
| Editability       | Always editable, even during recording | Clinicians jot notes while dictating                           |
| Visual style      | Card with label header                 | Visually distinct from the transcript's document-style feel    |
| Storage           | New `"context_note"` AttachmentKind    | Follows existing attachment pattern, no architecture changes   |
| Creator           | `"user"`, Role: `"source"`             | User-authored content, not derived                             |
| Auto-save         | Trailing-edge debounce (~1000ms)       | No explicit save button; feels like a notes field              |
| Flush on navigate | Yes                                    | Pending debounce must flush before `openRoute` replaces state  |

## Technical Approach

### Files to Modify

| File                                        | Change                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `src/domain/recording.ts`                   | Add `"context_note"` to `AttachmentKind` and `TextAttachmentKind`   |
| `src-tauri/src/storage.rs`                  | Add `ContextNote` variant to Rust `AttachmentKind` enum             |
| `src/app/recording-service.ts`              | Add `saveContext()` and `loadContext()` methods                     |
| `src/app/recording-view-controller.ts`      | Add `contextNoteEl`, debounced auto-save, extend `RecordingContext` |
| `index.html`                                | Add context textarea HTML above the transcript                      |
| `src/main.ts`                               | Wire `contextNoteEl` to controller                                  |
| `src/styles.css`                            | Add card-style context area styles                                  |
| `src/app/recording-view-controller.test.ts` | Add context textarea tests                                          |

### Implementation Details

#### 1. Domain model (`src/domain/recording.ts`)

Add `"context_note"` to the union types:

```typescript
// line 8
export type AttachmentKind =
  | "transcript_raw"
  | "transcript_corrected"
  | "audio_capture"
  | "context_note";

// line 12
export type TextAttachmentKind = Extract<
  AttachmentKind,
  "transcript_raw" | "transcript_corrected" | "context_note"
>;
```

#### 2. Rust storage (`src-tauri/src/storage.rs`)

Add the variant in lockstep (line 17):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    TranscriptRaw,
    TranscriptCorrected,
    AudioCapture,
    ContextNote,
}
```

#### 3. RecordingService (`src/app/recording-service.ts`)

Add `saveContext` and `loadContext` methods that follow the same
get-modify-save pattern as `saveTranscript` / `loadTranscript`, but
filter on `kind === "context_note"` instead of `"transcript_raw"`.

```typescript
export interface SaveContextInput {
  recordingId: string;
  attachmentId?: string | null;
  context: string;
}

export interface SaveContextResult {
  recordingId: string;
  attachmentId: string;
  context: string;
}

export interface LoadedContextResult {
  recordingId: string;
  attachmentId: string | null;
  context: string;
}
```

Key differences from saveTranscript:

- **Empty text is valid.** `saveContext` should NOT throw on empty string
  (unlike `saveTranscript` which requires non-empty). A clinician clearing
  the context field is a valid action. When context is empty, skip the
  write and remove the attachment if one existed, or simply do nothing.
- Actually -- simplest approach: **always write the text**, even if empty.
  This avoids attachment-removal complexity. An empty text file costs nothing.
- Creator: `"user"`, not `"asr"`.
- Kind: `"context_note"`.

Add private helpers `findContextAttachment` and `pickContextAttachment`
that mirror `findAttachment` / `pickTranscriptAttachment` but filter on
`kind === "context_note"`.

#### 4. RecordingViewController (`src/app/recording-view-controller.ts`)

**Options interface** -- add:

```typescript
contextNoteEl: HTMLTextAreaElement;
```

**RecordingContext** -- extend:

```typescript
interface RecordingContext {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
  contextAttachmentId: string | null;
  contextText: string;
}
```

**Constructor** -- store `contextNoteEl`, set up `input` event listener
with debounced save:

```typescript
private readonly contextNoteEl: HTMLTextAreaElement;
private contextSaveTimer: ReturnType<typeof setTimeout> | null = null;

// In constructor:
this.contextNoteEl = options.contextNoteEl;
this.contextNoteEl.addEventListener("input", () => {
  this.scheduleContextSave();
});
```

**Debounced save:**

```typescript
private scheduleContextSave(): void {
  if (this.contextSaveTimer !== null) {
    clearTimeout(this.contextSaveTimer);
  }
  this.contextSaveTimer = setTimeout(() => {
    this.contextSaveTimer = null;
    void this.saveContext();
  }, 1000);
}

private flushContextSave(): void {
  if (this.contextSaveTimer !== null) {
    clearTimeout(this.contextSaveTimer);
    this.contextSaveTimer = null;
    void this.saveContext();
  }
}

private async saveContext(): Promise<void> {
  if (!this.context) return;
  const text = this.contextNoteEl.value;
  try {
    const saved = await this.recordingService.saveContext({
      recordingId: this.context.recordingId,
      attachmentId: this.context.contextAttachmentId,
      context: text,
    });
    this.context.contextAttachmentId = saved.attachmentId;
    this.context.contextText = saved.context;
    this.onRecordingsChanged();
  } catch (error) {
    this.onError(error, "Failed to save context");
  }
}
```

**openRoute** -- flush pending save before replacing state, then load
context for the new recording:

```typescript
// At the top of openRoute, before replacing this.context:
this.flushContextSave();

// When creating empty context:
this.context = createEmptyContext(...);  // now includes contextAttachmentId/contextText

// When loading existing recording, also load context:
const loadedContext = await this.recordingService.loadContext(recordingId);
this.context = {
  ...mapLoadedContext(loaded),
  contextAttachmentId: loadedContext?.attachmentId ?? null,
  contextText: loadedContext?.context ?? "",
};
this.contextNoteEl.value = this.context.contextText;
```

**createEmptyContext** -- extend:

```typescript
function createEmptyContext(recordingId: string): RecordingContext {
  return {
    recordingId,
    attachmentId: null,
    transcript: "",
    contextAttachmentId: null,
    contextText: "",
  };
}
```

**render** -- add context textarea value sync:

```typescript
// In renderTranscript or a new renderContext:
this.contextNoteEl.value = this.context?.contextText ?? "";
```

Wait -- the context textarea is user-editable, so we should NOT overwrite
it on every render. Only set its value when loading a recording (in
`openRoute`), not in the render loop. The user's typing is the source of
truth while the view is active.

#### 5. HTML (`index.html`)

Add inside `#screen-recording .view-body`, before the transcript textarea:

```html
<div class="context-card">
  <div class="context-card-header">
    <span class="context-card-label">Context</span>
  </div>
  <textarea
    id="contextNote"
    class="context-card-input"
    aria-label="Clinical context notes"
    placeholder="Add clinical context..."
    rows="3"
  ></textarea>
</div>
```

#### 6. main.ts wiring (`src/main.ts`)

Add to the RecordingViewController constructor call:

```typescript
contextNoteEl: mustTextarea("contextNote"),
```

#### 7. CSS (`src/styles.css`)

Add card-style context area (before the Recording Transcript section):

```css
/* ===== Context Card ===== */

#screen-recording .context-card {
  flex-shrink: 0;
  margin: var(--space-3) var(--space-4) 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  overflow: hidden;
}

#screen-recording .context-card-header {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

#screen-recording .context-card-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

#screen-recording .context-card-input {
  width: 100%;
  padding: var(--space-3);
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  resize: none;
  outline: none;
}

#screen-recording .context-card-input::placeholder {
  color: var(--text-muted);
}
```

#### 8. Tests (`src/app/recording-view-controller.test.ts`)

Extend `makeController` to include `contextNoteEl`:

```typescript
const contextNoteEl = document.createElement("textarea");
```

Pass to constructor. Add test cases:

- **Context textarea value set on openRoute with existing recording:**
  Stub `loadContext` to return text, call `openRoute(id)`, assert
  `contextNoteEl.value` matches
- **Context textarea cleared on openRoute(null):**
  Call `openRoute(null)`, assert `contextNoteEl.value === ""`
- **Debounced save fires after input event:**
  Use fake timers, dispatch `input` event on contextNoteEl, advance 1000ms,
  assert `saveContext` was called on the service
- **Multiple inputs within debounce window only save once:**
  Dispatch input, advance 500ms, dispatch input, advance 1000ms, assert
  saveContext called once
- **flushContextSave on openRoute:**
  Type into contextNoteEl, call openRoute(null) before debounce fires,
  assert saveContext was called (flushed)

## Acceptance Criteria

- [x] Card-style context textarea appears above the transcript on the recording screen
- [x] Context textarea has a "Context" label header
- [x] Context is editable at all times (before, during, and after recording)
- [x] Context auto-saves with debounce as the user types
- [x] Context is stored as a `"context_note"` attachment on the recording
- [x] Loading an existing recording restores the saved context text
- [x] Opening a new recording clears the context field
- [x] Pending debounced save flushes before navigating away
- [x] Rust `AttachmentKind` enum includes `ContextNote` variant
- [x] All new tests pass
- [x] Existing tests still pass

## Out of Scope

- Combining context + transcript for artifact generation (future feature)
- Rich text editing or structured fields in the context area
- Context templates or pre-filled suggestions
- Auto-grow textarea height (fixed rows with scroll for now)

## References

- Brainstorm: `docs/brainstorms/2026-02-16-context-textarea-brainstorm.md`
- Recording domain model: `src/domain/recording.ts`
- Recording service: `src/app/recording-service.ts`
- Recording view controller: `src/app/recording-view-controller.ts`
- Rust storage: `src-tauri/src/storage.rs`
- Existing card styles: `src/styles.css:394-431`
- Context input styles: `src/styles.css:519-542`
