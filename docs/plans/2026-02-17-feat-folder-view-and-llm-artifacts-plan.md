---
title: "Folder View with LLM Artifact Generation"
type: feat
date: 2026-02-17
---

# Folder View with LLM Artifact Generation

## Overview

Transform the recording screen from a flat transcript view into a **folder view** that treats each recording as a container of related artifacts. Add a "Create" action that invokes the LLM plugin to generate clinical documents (SOAP notes, progress notes, referral letters) from the transcript + context. Add an artifact detail view for reading, copying, and deleting generated documents.

This replicates the three-view navigation pattern from the reference MedGemma project — **List > Folder > Detail** — while preserving Dr. Toru's existing architecture (vanilla TS, controller pattern, plugin system, Tauri backend).

## Problem Statement / Motivation

The current recording screen shows only a transcript textarea and a context card. There is no way to:

1. Generate clinical documents (SOAP notes, etc.) from a transcript
2. View multiple derived artifacts for a single recording
3. Navigate into a full-screen view of a generated document

The LLM plugin system exists and works (llamafile via Rust child process), but it's only exposed in the Settings screen as a test panel. The pipeline `(transcript + context) → artifacts` needs a production UI.

## Proposed Solution

### Three-view navigation: List → Folder → Detail

```
#list              → Sessions list (exists, minor enhancement)
#recording/{id}    → Folder view (recording as container of cards)
#detail/{rid}/{aid}→ Artifact detail (full-screen read of one artifact)
```

### Data model extension

Add a new `AttachmentKind`: `"llm_artifact"` with metadata tracking the artifact type (soap, progress, referral) and the source transcript/context attachment IDs.

### Folder view transformation

Replace the current recording screen body with a scrollable list of **cards**:

- **Context card** (existing — editable textarea)
- **Transcript card** (existing — readonly textarea, expandable)
- **Artifact cards** (new — one per generated artifact, tap to open detail)

### Create action with bottom sheet

Add a "Create" button next to "Transcribe" in the folder-actions bar. Tapping it opens a slide-up sheet (CSS already partially defined in styles.css) with template options:

- SOAP Note
- Progress Note
- Referral Letter

### Artifact detail view

A new screen showing the full content of a single artifact with:

- Back button (→ folder)
- Copy to clipboard
- Delete artifact

## Technical Approach

### Phase 1: Domain & Storage — New AttachmentKind

**Files to modify:**

- `src/domain/recording.ts` — Add `"llm_artifact"` to `AttachmentKind` union, add to `TextAttachmentKind`
- `src-tauri/src/storage.rs` — Add `LlmArtifact` variant to Rust `AttachmentKind` enum

The attachment will carry metadata:

```typescript
// metadata fields on an llm_artifact attachment
{
  artifactType: "soap" | "progress" | "referral",  // template used
  sourceTranscriptId: string,    // attachmentId of transcript_raw used
  sourceContextId: string | null // attachmentId of context_note used
}
```

No new tables, no new directories. Just a new attachment kind stored as `{attachmentId}.txt` in the existing `attachments/` directory, following the exact same pattern as `transcript_raw` and `context_note`.

### Phase 2: RecordingService — Artifact CRUD

**File: `src/app/recording-service.ts`**

Add three methods:

```typescript
// Save a new LLM-generated artifact
async saveArtifact(input: {
  recordingId: string;
  artifactType: string;
  content: string;
  sourceTranscriptId: string | null;
  sourceContextId: string | null;
}): Promise<{ attachmentId: string }>

// Load all llm_artifact attachments for a recording
async loadArtifacts(recordingId: string): Promise<Array<{
  attachmentId: string;
  artifactType: string;
  content: string;
  createdAt: string;
}>>

// Delete an artifact attachment
async deleteArtifact(input: {
  recordingId: string;
  attachmentId: string;
}): Promise<void>
```

These follow the same internal pattern as `saveTranscript` / `loadTranscript`:

- Create a new `Attachment` with `kind: "llm_artifact"`, `role: "derived"`, `createdBy: "llm"`
- Write content via `store.writeAttachmentText()`
- Delete by removing the attachment from the `Recording.attachments` array and calling `store.saveRecording()`

### Phase 3: Router — Add Detail Route

**File: `src/app/router.ts`**

```typescript
type AppRoute =
  | { name: "recording"; recordingId: string | null }
  | { name: "detail"; recordingId: string; attachmentId: string } // NEW
  | { name: "list" }
  | { name: "settings" };
```

Hash format: `#detail/{recordingId}/{attachmentId}`

Add `"detail"` to `ROUTE_NAMES`. Update `parseRoute()` and `routeToHash()` to handle the three-segment detail route. The detail route is a child of recording conceptually — the back button returns to `#recording/{recordingId}`.

### Phase 4: Folder View — Recording Screen Transformation

**File: `src/app/recording-view-controller.ts`**

Extend `RecordingViewController` to manage artifact cards:

1. **Track artifacts** — `openRoute()` now also calls `recordingService.loadArtifacts(recordingId)` and stores the result
2. **Render artifact cards** — After the transcript textarea, render a card for each artifact:
   ```html
   <button class="folder-card" data-attachment-id="...">
     <span class="folder-card-type">SOAP Note</span>
     <span class="folder-card-preview"
       >SUBJECTIVE: Patient presents with...</span
     >
     <span class="folder-card-date">Feb 17, 2026</span>
   </button>
   ```
3. **Card tap** — Navigates to `#detail/{recordingId}/{attachmentId}`

Add a container element in index.html for artifact cards:

```html
<!-- Inside #screen-recording .view-body, after transcript -->
<div id="artifactCards" class="artifact-cards-container"></div>
```

**File: `index.html`**

Add the artifact cards container and the "Create" button:

```html
<div class="folder-actions">
  <button
    id="recordBtn"
    class="action-btn action-record"
    type="button"
    disabled
  >
    Transcribe
  </button>
  <button
    id="createBtn"
    class="action-btn action-create"
    type="button"
    disabled
  >
    Create
  </button>
</div>
```

### Phase 5: Create Sheet — Template Selection

**New file: `src/app/create-sheet-controller.ts`**

A controller for the slide-up bottom sheet:

```typescript
interface CreateSheetControllerOptions {
  overlayEl: HTMLElement;
  sheetEl: HTMLElement;
  onSelect: (templateType: string) => void;
}
```

Templates are hardcoded (matching the reference project):

- **SOAP Note** — `type: "soap"`, prompt: "Convert to SOAP format"
- **Progress Note** — `type: "progress"`, prompt: "Convert to progress note"
- **Referral Letter** — `type: "referral"`, prompt: "Convert to referral letter"

The sheet slides up from the bottom via CSS transform. Overlay click or template selection closes it.

**File: `index.html`**

Add the sheet markup (the CSS class `.slide-sheet` already exists in styles.css):

```html
<div class="menu-overlay" id="create-overlay"></div>
<nav class="slide-sheet create-sheet" id="create-sheet">
  <div class="sheet-handle"></div>
  <div class="sheet-content">
    <h3 class="sheet-section-title">Create Document</h3>
    <div class="template-list" id="template-list">
      <!-- Template buttons rendered by CreateSheetController -->
    </div>
  </div>
</nav>
```

### Phase 6: LLM Artifact Generation — Wiring the Pipeline

**File: `src/app/recording-view-controller.ts`** (or new controller)

When user selects a template:

1. Show processing overlay
2. Read current transcript text + context text
3. Call `llm.run(combinedInput, action)` where action maps to a prompt template:
   - `"soap"` → existing prompt in llamafile runtime
   - `"progress"` → new prompt: "Convert this clinical dictation into a progress note..."
   - `"referral"` → new prompt: "Convert this clinical dictation into a referral letter..."
4. Save result via `recordingService.saveArtifact()`
5. Hide processing overlay
6. Navigate to detail view OR re-render folder with new card

**Prompt templates** should be defined in the LLM runtime adapter or a simple constants file. The llamafile Rust command already supports a custom `prompt` parameter via `plugin_runtime_llamafile_execute`.

**File: `src/app/artifact-prompts.ts`** (new)

```typescript
export const ARTIFACT_PROMPTS: Record<
  string,
  { title: string; systemPrompt: string }
> = {
  soap: {
    title: "SOAP Note",
    systemPrompt:
      "Convert the following clinical dictation into a structured SOAP note with sections: SUBJECTIVE, OBJECTIVE, ASSESSMENT, PLAN.",
  },
  progress: {
    title: "Progress Note",
    systemPrompt:
      "Convert the following clinical dictation into a progress note documenting a follow-up visit.",
  },
  referral: {
    title: "Referral Letter",
    systemPrompt:
      "Convert the following clinical dictation into a professional referral letter to a specialist.",
  },
};
```

### Phase 7: Detail View — Artifact Read/Copy/Delete

**New file: `src/app/detail-view-controller.ts`**

```typescript
interface DetailViewControllerOptions {
  contentEl: HTMLElement;
  typeEl: HTMLElement;
  dateEl: HTMLElement;
  copyBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  recordingService: RecordingService;
  onDeleted: () => void;
  onError: (error: unknown, context: string) => void;
}
```

Methods:

- `openRoute(recordingId, attachmentId)` — Load the artifact content and render
- Copy button — `navigator.clipboard.writeText(content)`
- Delete button — Confirm, then `recordingService.deleteArtifact()`, then `onDeleted()` navigates back to folder

**File: `index.html`**

```html
<section
  id="screen-detail"
  class="view"
  data-screen="detail"
  hidden
  aria-hidden="true"
>
  <header class="view-header">
    <button
      id="detailBackBtn"
      class="back-btn"
      type="button"
      aria-label="Back to recording"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <div class="view-header-content">
      <span id="detailType" class="detail-type">SOAP Note</span>
      <span id="detailDate" class="detail-date"></span>
    </div>
    <div class="detail-actions">
      <button id="detailCopyBtn" class="copy-btn" type="button">Copy</button>
      <button id="detailDeleteBtn" class="delete-btn" type="button">
        Delete
      </button>
    </div>
  </header>
  <div class="view-body">
    <div id="detailContent" class="detail-content"></div>
  </div>
</section>
```

### Phase 8: Main.ts Wiring

**File: `src/main.ts`**

1. Add `screenEls.detail` to the screen map
2. Create `DetailViewController` instance
3. Create `CreateSheetController` instance
4. Wire "Create" button → open sheet
5. Wire sheet template selection → LLM generation pipeline
6. Wire detail route handling in `setRoute()`
7. Wire `createBtn.disabled` based on `llm.isRunning()` && has transcript
8. Update `renderPluginStatus()` to enable/disable Create button

### Phase 9: CSS

**File: `src/styles.css`**

New styles needed:

- `.artifact-cards-container` — vertical stack of cards
- `.folder-card` — clickable card with type, preview, date
- `.folder-card-type`, `.folder-card-preview`, `.folder-card-date` — card internals
- `.detail-content` — rendered artifact text (pre-wrap, readable)
- `.detail-actions` — header action buttons
- `.copy-btn`, `.delete-btn` — action button styles
- `.action-create` — Create button styling (sparkle/star accent)
- Enhancement of existing `.slide-sheet` and `.menu-overlay` (already partially defined)
- `.template-btn`, `.template-info` — template list item in sheet
- `.processing-overlay` — full-screen spinner during LLM generation

## Acceptance Criteria

### Functional Requirements

- [ ] Recording screen shows Context card, Transcript card, and Artifact cards as a scrollable folder
- [ ] "Create" button appears next to "Transcribe" button, disabled when LLM is not running or no transcript exists
- [ ] Tapping "Create" opens a bottom sheet with SOAP Note, Progress Note, and Referral Letter templates
- [ ] Selecting a template invokes the LLM plugin with the transcript + context and appropriate prompt
- [ ] Processing overlay shows while LLM is generating
- [ ] Generated artifact is saved as an `llm_artifact` attachment with provenance metadata
- [ ] New artifact card appears in the folder after generation
- [ ] Tapping an artifact card navigates to `#detail/{recordingId}/{attachmentId}`
- [ ] Detail view shows full artifact content, type label, and creation date
- [ ] Copy button copies artifact text to clipboard
- [ ] Delete button removes the artifact (with confirmation) and navigates back to folder
- [ ] Back button in detail view returns to the recording folder
- [ ] Back button in folder view returns to session list
- [ ] Navigation follows clear forward/backward relationship: List → Folder → Detail
- [ ] Multiple artifacts can be generated from the same transcript
- [ ] Artifacts persist across app restarts (stored via Tauri recording store)

### Non-Functional Requirements

- [ ] No framework introduced — vanilla TypeScript + DOM manipulation
- [ ] Follows existing controller pattern with options-object constructors
- [ ] New attachment kind works with both TauriRecordingStore and NoopRecordingStore
- [ ] CSS uses existing design tokens (--accent-primary, --space-N, etc.)
- [ ] Settings view is NOT modified (per colleague instruction)

### Quality Gates

- [ ] Unit tests for RecordingService artifact methods
- [ ] Unit tests for DetailViewController
- [ ] Unit tests for CreateSheetController
- [ ] Router tests for detail route parsing
- [ ] All existing tests pass (`pnpm test`)
- [ ] TypeScript compiles clean (`pnpm check`)

## Dependencies & Prerequisites

- LLM plugin must be imported and service started (existing Settings flow)
- The llamafile `plugin_runtime_llamafile_execute` command already supports custom `prompt` parameter — no Rust changes needed beyond adding the `LlmArtifact` variant to `AttachmentKind`

## File Manifest

### New Files

| File                                      | Purpose                                        |
| ----------------------------------------- | ---------------------------------------------- |
| `src/app/create-sheet-controller.ts`      | Bottom sheet controller for template selection |
| `src/app/detail-view-controller.ts`       | Artifact detail view controller                |
| `src/app/artifact-prompts.ts`             | Prompt templates for each artifact type        |
| `src/app/create-sheet-controller.test.ts` | Tests for create sheet                         |
| `src/app/detail-view-controller.test.ts`  | Tests for detail view                          |

### Modified Files

| File                                   | Changes                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/domain/recording.ts`              | Add `"llm_artifact"` to AttachmentKind                                                                      |
| `src-tauri/src/storage.rs`             | Add `LlmArtifact` variant to Rust AttachmentKind enum                                                       |
| `src/app/recording-service.ts`         | Add `saveArtifact()`, `loadArtifacts()`, `deleteArtifact()`                                                 |
| `src/app/recording-view-controller.ts` | Add artifact card rendering, track artifacts in context                                                     |
| `src/app/router.ts`                    | Add `detail` route type and parsing                                                                         |
| `src/main.ts`                          | Wire new controllers, Create button, detail screen                                                          |
| `index.html`                           | Add detail screen section, Create button, create sheet markup, artifact cards container, processing overlay |
| `src/styles.css`                       | Add folder card, detail view, create sheet, processing overlay styles                                       |
| `src/app/recording-service.test.ts`    | Add tests for artifact CRUD                                                                                 |
| `src/app/router.test.ts`               | Add tests for detail route                                                                                  |

## Implementation Order

1. Domain + Rust enum (`recording.ts`, `storage.rs`) — 10 min
2. RecordingService artifact methods + tests — 30 min
3. Router detail route + tests — 15 min
4. artifact-prompts.ts constants — 5 min
5. HTML structure (index.html) — 15 min
6. CSS (styles.css) — 20 min
7. CreateSheetController + tests — 20 min
8. DetailViewController + tests — 20 min
9. RecordingViewController folder cards — 20 min
10. main.ts wiring — 20 min
11. Integration testing — 15 min

## References

### Internal References

- Recording domain model: `src/domain/recording.ts`
- Recording service pattern: `src/app/recording-service.ts`
- View controller pattern: `src/app/recording-view-controller.ts`
- LLM execution: `src/plugins/runtime-adapter.ts:190-208` (LlamafileRuntimeAdapter.execute)
- LLM controller: `src/app/llm-controller.ts`
- Existing CSS slide-sheet: `src/styles.css` (search `.slide-sheet`)
- Rust attachment kind enum: `src-tauri/src/storage.rs`
- Rust llamafile execute: `src-tauri/src/plugins/mod.rs:449-462`

### Design Decisions

- **No backend API server** — Unlike the reference MedGemma project (FastAPI), Dr. Toru uses Tauri invoke commands. All LLM calls go through the existing `plugin_runtime_llamafile_execute` command with custom prompts.
- **Attachments, not sessions** — The reference project uses a session/artifact model. Dr. Toru uses recording/attachment model. Generated documents become attachments with `kind: "llm_artifact"`.
- **Static templates, not AI suggestions** — The reference project has a `/suggest` endpoint. For MVP, templates are hardcoded. AI-powered suggestions can be added later.
- **No streaming** — The reference project streams tokens via WebSocket. Dr. Toru's llamafile adapter returns the full response. Streaming can be added later as a separate enhancement.
