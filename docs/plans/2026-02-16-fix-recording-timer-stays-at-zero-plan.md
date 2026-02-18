---
title: "fix: Recording timer stays at 0:00"
type: fix
date: 2026-02-16
---

# fix: Recording timer stays at 0:00 during recording

## Overview

The timer in the dictation view header shows "0:00" and never updates, even
while actively recording. Transcription works fine -- the timer placeholder was
added in the design system commit (`ff5b113`) but no timer logic was ever
implemented.

This is **missing implementation**, not a regression.

## Root Cause

The `<span class="meta-item meta-timer">0:00</span>` in `index.html:53` is
static HTML. No JavaScript references this element, no interval updates it,
and no elapsed-time tracking exists anywhere in the codebase.

The CSS `.meta-timer.recording { color: var(--error); }` in `src/styles.css:197-199`
is defined but never applied because no code toggles the `.recording` class on
the timer span.

## Acceptance Criteria

- [x] Timer displays `0:00` when idle
- [x] Timer counts up in `M:SS` format while recording (computed from wall-clock `Date.now()`, not an incrementing counter, to avoid drift)
- [x] Timer span gets `.recording` class while recording (red text via existing CSS)
- [x] Timer freezes at final elapsed time when recording stops (e.g. "3:42")
- [x] Timer resets to `0:00` when a new recording session is opened (`openRoute(null)`)
- [x] `setInterval` is always cleaned up on stop, route change, and shutdown
- [x] Recordings >= 10 minutes display as `MM:SS` (e.g. "12:30"); >= 60 minutes as `MMM:SS` (e.g. "72:15") -- no hour boundary formatting needed

## Implementation

### 1. Add `id` to timer element

**`index.html:53`**

```html
<span id="recordingTimer" class="meta-item meta-timer">0:00</span>
```

Add `role="timer"` and `aria-label="Recording duration"` for accessibility.

### 2. Wire element into `RecordingViewController`

**`src/app/recording-view-controller.ts`**

Add `timerEl: HTMLElement` to `RecordingViewControllerOptions` interface. Pass it
from `main.ts` using the existing `mustEl('recordingTimer')` pattern.

### 3. Implement timer logic in `RecordingViewController`

Add private fields:

```typescript
private timerInterval: ReturnType<typeof setInterval> | null = null;
private recordingStartTime: number | null = null;
```

In `setRecording(true)`:

1. Set `this.recordingStartTime = Date.now()`
2. Start `this.timerInterval = setInterval(() => this.updateTimer(), 1000)`
3. Call `this.updateTimer()` immediately for instant "0:00" -> "0:01" feedback

In `setRecording(false)`:

1. `clearInterval(this.timerInterval)` and null it
2. Keep `recordingStartTime` so the frozen time persists in the display
3. Remove `.recording` class from `timerEl`

In `openRoute(null)` (new recording path):

1. Clear any running interval
2. Set `recordingStartTime = null`
3. Reset `timerEl.textContent = '0:00'`
4. Remove `.recording` class

### 4. Add `formatElapsed` utility

Pure function, either inline or extracted:

```typescript
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
```

### 5. Toggle `.recording` class on timer in `render()`

In the existing `render()` method, add:

```typescript
this.timerEl.classList.toggle("recording", this.recording);
```

Parallel to the existing button class toggle.

### 6. Add tests

**`src/app/recording-view-controller.test.ts`**

- Unit test `formatElapsed`: 0ms, 59999ms, 60000ms, 599000ms, 3600000ms
- Integration test with `vi.useFakeTimers()`:
  - Start recording -> advance 5s -> verify "0:05" and `.recording` class
  - Stop recording -> verify frozen time, no `.recording` class
  - Open new route -> verify reset to "0:00"

## Files Changed

| File                                        | Change                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `index.html`                                | Add `id="recordingTimer"` and ARIA attrs to timer span                                 |
| `src/app/recording-view-controller.ts`      | Add `timerEl` option, timer interval logic, `formatElapsed`, `.recording` class toggle |
| `src/main.ts`                               | Wire `timerEl` via `mustEl('recordingTimer')` into controller options                  |
| `src/app/recording-view-controller.test.ts` | Add timer tests                                                                        |

## Out of Scope

- Persisting duration to the `Recording` domain model (separate enhancement)
- Displaying duration in the session list view
- Hour-boundary formatting (`H:MM:SS`) -- minutes just keep counting
