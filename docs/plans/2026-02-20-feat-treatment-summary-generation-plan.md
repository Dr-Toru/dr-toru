---
title: "feat: Treatment Summary Generation"
type: feat
date: 2026-02-20
---

# Treatment Summary Generation

## Overview

Add treatment summary generation as the second LLM document type. User
taps a "Summary" button in the recording view, the LLM generates a
structured clinical letter (Japanese 紹介状-style, in English), the
result is saved as an attachment with provenance, and displayed in its
own tab.

No architectural changes. Same pipeline as SOAP notes with a different
action name, prompt, attachment kind, and UI tab.

## Proposed Solution

- **Rust**: Add `"treatment_summary"` prompt to `default_llamafile_prompt`
- **Domain**: Add `treatment_summary` to `AttachmentKind` (TS + Rust)
- **Controller**: Add `generateTreatmentSummary()` mirroring SOAP flow
- **UI**: Add "Summary" tab + generate button + copy button + overlay

## Changes

### 1. Domain: Add `treatment_summary` attachment kind

**`src/domain/recording.ts`**

Add `"treatment_summary"` to both type unions:

```typescript
export type AttachmentKind =
  | "transcript_raw"
  | "transcript_corrected"
  | "audio_capture"
  | "context_note"
  | "soap_note"
  | "treatment_summary";

export type TextAttachmentKind = Extract<
  AttachmentKind,
  | "transcript_raw"
  | "transcript_corrected"
  | "context_note"
  | "soap_note"
  | "treatment_summary"
>;
```

**`src-tauri/src/storage.rs`** -- Add `TreatmentSummary` variant to
Rust enum. `#[serde(rename_all = "snake_case")]` already on the enum
handles serialization as `"treatment_summary"`.

No changes to `RecordingService` -- `saveAttachmentText` and
`loadAttachmentText` are already generic over `TextAttachmentKind`.

### 2. Rust: Add treatment summary prompt

**`src-tauri/src/plugins/llamafile.rs`**

Add a new match arm in `default_llamafile_prompt`:

```rust
fn default_llamafile_prompt(action: &str) -> String {
    match action {
        "soap" => /* ... existing ... */,
        "treatment_summary" => concat!(
            "Convert the following clinical note into a treatment summary letter.\n\n",
            "Write a professional clinical letter with these sections in order:\n\n",
            "1. GREETING: Begin with \"Dear Colleague,\"\n",
            "2. PATIENT RELATIONSHIP: State how the patient is known to the author ",
            "(e.g. \"This patient has been followed at our clinic since...\", ",
            "\"This patient presented to our clinic on...\").\n",
            "3. CLINICAL PROBLEM AND NEEDS: Describe the clinical problem and ",
            "what is being requested (e.g. additional examinations, specialist opinion, ",
            "continued management).\n",
            "4. MEDICATION AND TREATMENT NOTES: Note relevant medications, treatments ",
            "given or not given and why (e.g. \"The patient declined X\" or ",
            "\"X was not prescribed due to...\").\n",
            "5. CLOSING: End with a polite professional closing ",
            "(e.g. \"Thank you for your kind attention to this patient. ",
            "Please do not hesitate to contact us if you require further information.\").\n\n",
            "Keep medical terminology accurate. ",
            "Write in a professional, concise tone. ",
            "Do not invent a recipient name -- use \"Dear Colleague\" only. ",
            "Output only the letter with no additional commentary or critique."
        ).to_string(),
        _ => "Correct grammar and punctuation while preserving clinical meaning.".to_string(),
    }
}
```

Token limit is already 2048 globally -- sufficient for a letter.

### 3. UI: Add Summary tab and button

**`index.html`**

#### 3a. Add "Summary" tab button and copy button to tab bar

After the SOAP tab button and copy button, add:

```html
<button id="tabTreatmentSummary" class="tab-btn" type="button">Summary</button>
<button
  id="treatmentSummaryCopyBtn"
  class="section-action-btn tab-action"
  type="button"
  hidden
>
  Copy
</button>
```

#### 3b. Add Summary panel

After `#panelSoap`, add:

```html
<div id="panelTreatmentSummary" class="tab-panel" hidden>
  <div id="treatmentSummarySection" hidden>
    <div id="treatmentSummaryContent" class="artifact-content"></div>
  </div>
  <div id="treatmentSummaryBlankState" class="artifact-blank-state">
    <p class="blank-state-text">
      Generate a treatment summary from your transcript
    </p>
  </div>
</div>
```

#### 3c. Add processing overlay

After the SOAP overlay:

```html
<div class="processing-overlay" id="treatmentSummaryOverlay" hidden>
  <div class="spinner"></div>
  <p>Generating treatment summary...</p>
</div>
```

#### 3d. Add "Summary" button to action bar

After the SOAP button:

```html
<button
  id="treatmentSummaryBtn"
  class="upload-btn"
  type="button"
  disabled
  aria-label="Generate treatment summary"
>
  <svg ...><!-- letter/envelope icon --></svg>
  Summary
</button>
```

### 4. Controller: Generation orchestration

**`src/app/recording-view-controller.ts`**

#### 4a. Expand options interface

Add to `RecordingViewControllerOptions`:

```typescript
treatmentSummaryBtn: HTMLButtonElement;
treatmentSummarySectionEl: HTMLElement;
treatmentSummaryContentEl: HTMLElement;
treatmentSummaryBlankStateEl: HTMLElement;
treatmentSummaryCopyBtn: HTMLButtonElement;
treatmentSummaryOverlayEl: HTMLElement;
treatmentSummaryTabBtn: HTMLButtonElement;
treatmentSummaryPanel: HTMLElement;
```

Add corresponding private fields on the class and assign in
constructor.

#### 4b. Expand RecordingContext

```typescript
interface RecordingContext {
  // ... existing fields ...
  soapAttachmentId: string | null;
  soapText: string;
  treatmentSummaryAttachmentId: string | null;
  treatmentSummaryText: string;
}
```

Update `createEmptyContext` and `mapLoadedContext` to include
`treatmentSummaryAttachmentId: null` and `treatmentSummaryText: ""`.

#### 4c. Refactor `switchTab` for three tabs

Change the type from `"context" | "soap"` to
`"context" | "soap" | "treatment_summary"`:

```typescript
switchTab(tab: "context" | "soap" | "treatment_summary"): void {
    this.contextTabBtn.classList.toggle("is-active", tab === "context");
    this.soapTabBtn.classList.toggle("is-active", tab === "soap");
    this.treatmentSummaryTabBtn.classList.toggle("is-active", tab === "treatment_summary");
    this.contextPanel.hidden = tab !== "context";
    this.soapPanel.hidden = tab !== "soap";
    this.treatmentSummaryPanel.hidden = tab !== "treatment_summary";
    this.updateSoapCopyBtn();
    this.updateTreatmentSummaryCopyBtn();
}
```

Wire the tab button click handler in constructor:

```typescript
this.treatmentSummaryTabBtn.addEventListener("click", () => {
  this.switchTab("treatment_summary");
});
```

#### 4d. Add `generateTreatmentSummary` method

Same pattern as `generateSoapNote`:

```typescript
async generateTreatmentSummary(): Promise<void> {
  if (!this.context || this.generating) return;
  if (!this.context.transcript.trim()) return;
  if (!this.context.attachmentId) return;

  this.generating = true;
  this.treatmentSummaryOverlayEl.hidden = false;
  this.treatmentSummaryOverlayEl.classList.add("visible");
  this.render();

  try {
    await this.flushContextSave();

    const transcript = this.context.transcript;
    const context = this.contextNoteEl.value.trim();
    let input = `Transcript:\n${transcript}`;
    if (context) {
      input += `\n\nClinician's Notes:\n${context}`;
    }

    const text = await this.platform.runLlm("treatment_summary", input);

    const result = await this.recordingService.saveAttachmentText({
      recordingId: this.context.recordingId,
      attachmentId: this.context.treatmentSummaryAttachmentId,
      kind: "treatment_summary",
      createdBy: "llm",
      text,
      setActive: false,
      role: "derived",
      sourceAttachmentId: this.context.attachmentId,
    });

    this.context.treatmentSummaryAttachmentId = result.attachmentId;
    this.context.treatmentSummaryText = text;
    this.renderTreatmentSummary();
    this.switchTab("treatment_summary");
  } catch (err) {
    this.onError(err, "Treatment summary generation");
  } finally {
    this.generating = false;
    this.treatmentSummaryOverlayEl.classList.remove("visible");
    this.treatmentSummaryOverlayEl.hidden = true;
    this.render();
  }
}
```

Wire button click in constructor:

```typescript
this.treatmentSummaryBtn.addEventListener("click", () => {
  void this.generateTreatmentSummary();
});
```

#### 4e. Add render and copy helpers

```typescript
private renderTreatmentSummary(): void {
    const text = this.context?.treatmentSummaryText ?? "";
    if (text) {
      this.treatmentSummaryContentEl.textContent = text;
      this.treatmentSummarySectionEl.hidden = false;
      this.treatmentSummaryBlankStateEl.hidden = true;
    } else {
      this.treatmentSummaryContentEl.textContent = "";
      this.treatmentSummarySectionEl.hidden = true;
      this.treatmentSummaryBlankStateEl.hidden = false;
    }
    this.updateTreatmentSummaryCopyBtn();
}

private updateTreatmentSummaryCopyBtn(): void {
    const show = !this.treatmentSummaryPanel.hidden && !this.treatmentSummarySectionEl.hidden;
    this.treatmentSummaryCopyBtn.hidden = !show;
}
```

#### 4f. Load existing summary on navigation

In `openRoute()`, after loading SOAP:

```typescript
const summary = await this.recordingService.loadAttachmentText(
  recordingId,
  "treatment_summary",
);
if (summary) {
  this.context.treatmentSummaryAttachmentId = summary.attachmentId;
  this.context.treatmentSummaryText = summary.text;
}
```

#### 4g. Clear on re-recording

In `onRecordingComplete()`, alongside SOAP clearing:

```typescript
this.context.treatmentSummaryAttachmentId = null;
this.context.treatmentSummaryText = "";
this.renderTreatmentSummary();
```

#### 4h. Disable button in `render()`

Add alongside SOAP button disable logic:

```typescript
this.treatmentSummaryBtn.disabled =
  !this.context?.transcript?.trim() || this.recording || this.generating;
```

### 5. Main wiring

**`src/main.ts`**

Pass new DOM elements to `RecordingViewController`:

```typescript
treatmentSummaryBtn: mustBtn("treatmentSummaryBtn"),
treatmentSummarySectionEl: mustEl("treatmentSummarySection"),
treatmentSummaryContentEl: mustEl("treatmentSummaryContent"),
treatmentSummaryBlankStateEl: mustEl("treatmentSummaryBlankState"),
treatmentSummaryCopyBtn: mustBtn("treatmentSummaryCopyBtn"),
treatmentSummaryOverlayEl: mustEl("treatmentSummaryOverlay"),
treatmentSummaryTabBtn: mustBtn("tabTreatmentSummary"),
treatmentSummaryPanel: mustEl("panelTreatmentSummary"),
```

Wire copy button click handler (same pattern as SOAP copy):

```typescript
const treatmentSummaryCopyBtn = mustBtn("treatmentSummaryCopyBtn");
treatmentSummaryCopyBtn.addEventListener("click", () => {
  const el = mustEl("treatmentSummaryContent");
  const text = el.textContent?.trim();
  if (!text) return;
  void navigator.clipboard.writeText(text).then(() => {
    treatmentSummaryCopyBtn.textContent = "Copied";
    treatmentSummaryCopyBtn.classList.add("copied");
    setTimeout(() => {
      treatmentSummaryCopyBtn.textContent = "Copy";
      treatmentSummaryCopyBtn.classList.remove("copied");
    }, 1500);
  });
});
```

## Acceptance Criteria

- [x] `treatment_summary` added to `AttachmentKind` (TS and Rust)
- [x] Treatment summary prompt in `llamafile.rs` produces structured 5-section letter
- [x] "Summary" tab visible alongside Context and SOAP tabs
- [x] Three-way tab switching works correctly (only one panel visible at a time)
- [x] Summary button enabled only when transcript exists and not recording/generating
- [x] Processing overlay shown during generation with correct text
- [x] Generated summary displayed in Summary tab
- [x] Copy button copies summary text to clipboard
- [x] Existing summary loads when navigating to a recording
- [x] Regenerating overwrites the existing summary attachment
- [x] Summary cleared when transcript changes (re-recording)
- [x] Navigation blocked during generation (shared `generating` flag)
- [x] Errors handled via existing `onError` callback

## Files Changed

| File                                   | Change                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/domain/recording.ts`              | Add `treatment_summary` to `AttachmentKind` and `TextAttachmentKind`                          |
| `src-tauri/src/storage.rs`             | Add `TreatmentSummary` variant to Rust enum                                                   |
| `src-tauri/src/plugins/llamafile.rs`   | Add `"treatment_summary"` prompt to `default_llamafile_prompt`                                |
| `src/app/recording-view-controller.ts` | Add summary state, `generateTreatmentSummary()`, render helpers, expand `switchTab` to 3 tabs |
| `index.html`                           | Add Summary tab, panel, button, overlay, copy button                                          |
| `src/main.ts`                          | Wire new DOM elements and copy button handler                                                 |

## References

- Brainstorm: `docs/brainstorms/2026-02-20-treatment-summary-generation-brainstorm.md`
- SOAP plan (pattern to follow): `docs/plans/2026-02-19-feat-soap-note-generation-plan.md`
- Llamafile prompts: `src-tauri/src/plugins/llamafile.rs:21-38`
- Recording domain: `src/domain/recording.ts:8-17`
- Recording view controller: `src/app/recording-view-controller.ts`
- SOAP generation method: `src/app/recording-view-controller.ts:484-529`
- Tab switching: `src/app/recording-view-controller.ts:531-538`
- Main wiring: `src/main.ts:138-202`
