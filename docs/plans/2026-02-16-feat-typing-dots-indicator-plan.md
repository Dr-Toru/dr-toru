---
title: "feat: Add typing dots indicator during recording"
type: feat
date: 2026-02-16
---

# feat: Add typing dots indicator during recording

## Overview

When the user hits Transcribe, there is a ~6-second dead zone where the
transcript textarea is empty and gives no feedback that text is on the way.
Add an animated typing-dots indicator (three pulsing dots) that appears in
the transcript area during this initial wait and disappears once the first
chunk of transcript text arrives from the ASR engine.

## Problem Statement

After pressing Transcribe, the waveform bars in the header animate to show
the microphone is active, but the transcript area — where the user is
actually looking — sits completely empty. This creates confusion about
whether transcription is working. The gap typically lasts 6+ seconds while
the first audio chunk is captured and processed.

## Proposed Solution

Add a lightweight overlay `<div>` inside `.view-body` (sibling to the
`<textarea>`) containing three animated dots. The overlay is shown when
recording starts and hidden when either (a) the first non-empty transcript
arrives, or (b) recording stops — whichever comes first.

### Key Design Decisions

| Decision                   | Choice                                                                       | Rationale                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM strategy               | Sibling overlay div                                                          | Cannot put child elements inside a `<textarea>`. Overlay avoids changing existing textarea DOM references.                                                                                                                    |
| Show trigger               | `setRecording(true)`                                                         | Unambiguous signal that recording started. `setLiveTranscript("")` also fires on recording-complete with empty text, so it is not reliable.                                                                                   |
| Hide trigger               | First non-empty `setLiveTranscript(text)` OR `setRecording(false)`           | Covers both the happy path (text arrives) and early-stop/error paths.                                                                                                                                                         |
| Reappear on next recording | Yes                                                                          | Each `setRecording(true)` shows dots fresh.                                                                                                                                                                                   |
| Position                   | Top-left of textarea content area                                            | Matches where the first line of text will appear (respecting the textarea's padding). Simple to implement.                                                                                                                    |
| Placeholder conflict       | Hide via CSS when recording                                                  | Use `#transcript[data-recording]::placeholder { visibility: hidden }` to suppress "Tap Transcribe to begin dictation..." while dots are shown.                                                                                |
| Existing text              | Dots overlay is positioned at the top of the textarea, over existing content | The overlay covers the full textarea area at low opacity background or none. When there is existing text, the dots appear at the top, but since existing text will remain below and new text will append, this is acceptable. |
| Minimum display duration   | None                                                                         | The ~6s chunk processing time means the dots will always be visible long enough. A sub-second flash is only theoretically possible and not worth the complexity.                                                              |
| Animation style            | CSS-only scale+opacity pulse, three dots, staggered 160ms                    | Matches iMessage/WhatsApp pattern. CSS-only keeps it simple; no JS animation loop needed.                                                                                                                                     |
| Dot appearance             | 6px dots, `var(--text-muted)` color, 6px gap                                 | Subtle, matches design system, appropriately sized for 15px font context.                                                                                                                                                     |
| Accessibility              | `role="status"` with `aria-label` on the overlay                             | Screen readers announce "Preparing transcription" when dots appear.                                                                                                                                                           |

## Technical Approach

### Files to Modify

| File                                        | Change                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` (~line 108)                    | Add `<div id="typingIndicator" class="typing-indicator" role="status" aria-label="Preparing transcription" hidden>` with three `<span class="dot">` children, as a sibling after the `<textarea>` inside `.view-body`                                                                                                            |
| `src/app/recording-view-controller.ts`      | Add `typingIndicatorEl` to constructor options. Add `showTypingIndicator()` / `hideTypingIndicator()` private methods. Call show in `setRecording(true)`, call hide in `setLiveTranscript()` when text is non-empty and in `setRecording(false)`. Add `data-recording` attribute toggle on textarea for placeholder suppression. |
| `src/main.ts` (~line 133)                   | Pass `typingIndicatorEl: mustEl("typingIndicator")` to the RecordingViewController constructor                                                                                                                                                                                                                                   |
| `src/styles.css`                            | Add `.typing-indicator` positioning/layout styles, `.typing-indicator .dot` styles, `@keyframes typingPulse` animation, and `#transcript[data-recording]::placeholder` override                                                                                                                                                  |
| `src/app/recording-view-controller.test.ts` | Add tests for indicator visibility lifecycle                                                                                                                                                                                                                                                                                     |

### Implementation Details

#### 1. HTML (`index.html`)

Add after the `<textarea>` inside `.view-body`:

```html
<div
  id="typingIndicator"
  class="typing-indicator"
  role="status"
  aria-label="Preparing transcription"
  hidden
>
  <span class="dot"></span>
  <span class="dot"></span>
  <span class="dot"></span>
</div>
```

#### 2. CSS (`src/styles.css`)

```css
/* Typing indicator -- shown during initial recording wait */
#screen-recording .typing-indicator {
  position: absolute;
  top: var(--space-4);
  left: var(--space-4);
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}

#screen-recording .typing-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: typingPulse 1.4s ease-in-out infinite;
}

#screen-recording .typing-indicator .dot:nth-child(2) {
  animation-delay: 0.16s;
}

#screen-recording .typing-indicator .dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes typingPulse {
  0%,
  60%,
  100% {
    opacity: 0.3;
    transform: scale(1);
  }
  30% {
    opacity: 1;
    transform: scale(1.2);
  }
}

#transcript[data-recording]::placeholder {
  visibility: hidden;
}
```

The `.view-body` will need `position: relative` added so the absolutely
positioned indicator is contained within it.

#### 3. RecordingViewController (`src/app/recording-view-controller.ts`)

Add to options interface:

```typescript
typingIndicatorEl: HTMLElement;
```

Add private field and wire in constructor:

```typescript
private readonly typingIndicatorEl: HTMLElement;
// in constructor:
this.typingIndicatorEl = options.typingIndicatorEl;
```

Add show/hide methods:

```typescript
private showTypingIndicator(): void {
  this.typingIndicatorEl.hidden = false;
  this.transcriptEl.dataset.recording = "";
}

private hideTypingIndicator(): void {
  this.typingIndicatorEl.hidden = true;
  delete this.transcriptEl.dataset.recording;
}
```

Modify `setRecording()`:

```typescript
setRecording(recording: boolean): void {
  this.recording = recording;
  if (recording) {
    this.recordingStartTime = Date.now();
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
    this.showTypingIndicator();  // <-- NEW
  } else {
    this.clearTimerInterval();
    this.resetBars();
    this.hideTypingIndicator();  // <-- NEW
  }
  this.render();
}
```

Modify `setLiveTranscript()`:

```typescript
setLiveTranscript(transcript: string): void {
  this.liveTranscript = transcript;
  if (transcript) {
    this.hideTypingIndicator();  // <-- NEW: first real text arrived
  }
  this.renderTranscript();
}
```

#### 4. main.ts Wiring

Add to the RecordingViewController constructor call:

```typescript
typingIndicatorEl: mustEl("typingIndicator"),
```

#### 5. Tests (`recording-view-controller.test.ts`)

Add to `makeController` helper:

```typescript
const typingIndicatorEl = document.createElement("div");
typingIndicatorEl.hidden = true;
```

Pass in constructor options. Add test cases:

- **Typing indicator shown on recording start**: Call `setRecording(true)`, assert `typingIndicatorEl.hidden === false`
- **Typing indicator hidden when transcript text arrives**: Call `setRecording(true)`, then `setLiveTranscript("hello")`, assert `typingIndicatorEl.hidden === true`
- **Typing indicator hidden on recording stop**: Call `setRecording(true)`, then `setRecording(false)`, assert `typingIndicatorEl.hidden === true`
- **Empty transcript does not hide indicator**: Call `setRecording(true)`, then `setLiveTranscript("")`, assert `typingIndicatorEl.hidden === false`
- **Indicator reappears on second recording**: Full cycle — record, get text, stop, record again — assert indicator is visible again
- **data-recording attribute toggled**: Assert `transcriptEl.dataset.recording` is set when recording and removed when stopped

## Acceptance Criteria

- [x] Animated three-dot indicator appears in the transcript area within one frame of pressing Transcribe
- [x] Indicator disappears when the first non-empty transcript text arrives
- [x] Indicator disappears if user presses Stop before any text arrives
- [x] Indicator reappears on subsequent recordings
- [x] Placeholder text ("Tap Transcribe to begin dictation...") is hidden while indicator is visible
- [x] Screen reader announces "Preparing transcription" via `role="status"`
- [x] Animation is CSS-only (no JS animation loop)
- [x] All new tests pass
- [x] Existing tests still pass

## References

- Brainstorm: `docs/brainstorms/2026-02-16-typing-indicator-brainstorm.md`
- Recording view controller: `src/app/recording-view-controller.ts`
- Dictation controller: `src/app/dictation-controller.ts`
- Existing spinner CSS: `src/styles.css:647-670`
