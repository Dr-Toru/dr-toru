---
title: "feat: Audio-reactive waveform bars"
type: feat
date: 2026-02-16
---

# feat: Audio-reactive waveform bars

## Overview

The 4 status-indicator bars in the recording header use a looping CSS
animation that bears no relation to actual audio. Replace this with
real-time RMS levels computed in the existing `ScriptProcessorNode`
callback (~128ms / ~8fps).

## Problem Statement

The current waveform is cosmetic -- it loops `@keyframes waveform` with
staggered delays regardless of what the microphone picks up. This gives
no feedback about whether the mic is actually capturing sound, which is
especially confusing in a medical dictation app where confirmation of
audio input matters.

## Proposed Solution

Tap into the existing `onaudioprocess` callback in `AudioCapture` to
compute RMS from each 2048-sample buffer. Pass the level up through
`DictationController` to `RecordingViewController`, which sets bar
heights via inline styles. Remove the CSS animation; keep the green
color via the existing `:has(.recording)` selector.

## Acceptance Criteria

- [x] Bars respond to actual microphone audio levels while recording
- [x] Loud speech produces taller bars; silence returns bars near idle
- [x] 4 bars differ from each other (not identical lockstep) using fixed multipliers
- [x] Bars are green while recording (existing CSS `:has()` selector, kept)
- [x] Bars reset to 4px idle height when recording stops
- [x] CSS `@keyframes waveform` animation removed; `transition: height 100ms ease-out` added
- [x] No impact on ASR pipeline performance
- [x] Existing tests updated and new level tests added

## Implementation

### 1. Add `onLevel` callback to `AudioCapture.start()`

**`src/audio/capture.ts`**

Extract a `computeRms()` helper from the duplicated RMS logic in
`isSilent()`, then use it in both places:

```typescript
export type LevelCallback = (rms: number) => void;

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let power = 0;
  for (let i = 0; i < samples.length; i++) {
    power += samples[i] * samples[i];
  }
  return Math.sqrt(power / samples.length);
}
```

Refactor `isSilent()` to use `computeRms()` internally.

Add `private onLevel: LevelCallback | null = null` field alongside
`onChunk`. Add optional second parameter to `start()`:

```typescript
async start(onChunk: ChunkCallback, onLevel?: LevelCallback): Promise<void> {
  this.onChunk = onChunk;
  this.onLevel = onLevel ?? null;
  // ... rest unchanged
}
```

In `onAudioProcess`, before the buffering logic, fire the callback:

```typescript
if (this.onLevel) {
  this.onLevel(computeRms(input));
}
```

In `stop()`, null out `this.onLevel` alongside `this.onChunk`.

### 2. Add `onLevel` to `DictationController` options

**`src/app/dictation-controller.ts`**

Add `onLevel?: (rms: number) => void` to `DictationControllerOptions`.
Pass it through when calling `capture.start()`:

```typescript
await this.options.capture.start(
  (chunk) => void this.queueChunk(chunk),
  this.options.onLevel,
);
```

### 3. Wire in `main.ts`

**`src/main.ts`**

Pass the level callback from `DictationController` to
`RecordingViewController`:

```typescript
dictation = new DictationController({
  // ... existing options
  onLevel: (rms) => recordingView.setLevel(rms),
});
```

Pass the bar elements to the recording view controller:

```typescript
const barEls = Array.from(
  document.querySelectorAll<HTMLElement>(
    "#screen-recording .status-indicator .bar",
  ),
);

recordingView = new RecordingViewController({
  // ... existing options
  barEls,
});
```

### 4. Add `setLevel()` and bar management to `RecordingViewController`

**`src/app/recording-view-controller.ts`**

Add `barEls: readonly HTMLElement[]` to `RecordingViewControllerOptions`.

Module-level constants (alongside `MIN_BAR_HEIGHT` / `MAX_BAR_HEIGHT`):

```typescript
const BAR_SCALE = [0.7, 1.0, 0.85, 0.6] as const;
```

Add a `setLevel(rms: number)` method that maps RMS to bar heights:

```typescript
setLevel(rms: number): void {
  if (!this.recording || this.barEls.length === 0) return;
  const base = levelToHeight(rms);
  for (let i = 0; i < this.barEls.length; i++) {
    const bar = this.barEls[i];
    if (!bar) continue;
    const scale = BAR_SCALE[i] ?? 1;
    bar.style.height = `${Math.max(MIN_BAR_HEIGHT, base * scale)}px`;
  }
}
```

Add a `resetBars()` private method called from `setRecording(false)`:

```typescript
private resetBars(): void {
  for (const bar of this.barEls) {
    bar.style.height = `${MIN_BAR_HEIGHT}px`;
  }
}
```

### 5. RMS-to-height mapping function

**`src/app/recording-view-controller.ts`** (module-level, exported for testing)

Speech RMS typically ranges 0.01-0.15. A linear mapping wastes most of
the visual range. Use a sqrt curve (well-known perceptual loudness
approximation) so quiet speech is still visible. One tunable constant
(`LOUD_SPEECH_RMS = 0.15`) maps directly to "what level fills the bar":

```typescript
const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 20;
const LOUD_SPEECH_RMS = 0.15;

export function levelToHeight(rms: number): number {
  if (rms <= 0) return MIN_BAR_HEIGHT;
  const normalized = Math.sqrt(Math.min(rms / LOUD_SPEECH_RMS, 1));
  return MIN_BAR_HEIGHT + (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * normalized;
}
```

### 6. Update CSS

**`src/styles.css`**

Keep the `:has(.recording)` rule for the green `background` color.
Remove all `animation` and `animation-delay` properties. Delete the
`@keyframes waveform` block. Add a height transition to the base bar
rule:

```css
.status-indicator .bar {
  display: block;
  width: 3px;
  height: 4px;
  border-radius: 1.5px;
  background: var(--text-muted);
  transition:
    background 0.2s,
    height 100ms ease-out;
}

#screen-recording:has(.action-record.recording) .status-indicator .bar {
  background: var(--success);
  /* animation removed -- heights set by JS */
}

/* Remove all :nth-child animation-delay rules */
/* Remove @keyframes waveform block */
```

### 7. Tests

**`src/audio/capture.ts`** -- Not easily unit-tested (Web Audio API).
The `onLevel` callback is a trivial pass-through; testing it via
integration through `DictationController` tests would require mocking
`AudioCapture.start()`, which the existing tests already do.

**`src/app/recording-view-controller.test.ts`**:

- Unit test `computeRms`: zero-length, silence, known signal
- Unit test `levelToHeight`: 0, 0.005, 0.03, 0.10, 0.15, 1.0
- Integration test `setLevel()`: create bars, call `setLevel(0.05)`,
  verify bars have different heights matching `BAR_SCALE` multipliers
- Test `setLevel(0)` produces `MIN_BAR_HEIGHT` on all bars
- Test that `setLevel()` is a no-op when not recording
- Test that `setRecording(false)` resets bars to `MIN_BAR_HEIGHT`

## Files Changed

| File                                        | Change                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/audio/capture.ts`                      | Extract `computeRms()`, add `onLevel` callback to `start()`, refactor `isSilent()` |
| `src/app/dictation-controller.ts`           | Add `onLevel?` to options, pass through to `capture.start()`                       |
| `src/main.ts`                               | Wire `onLevel` callback, query bar elements, pass `barEls` to controller           |
| `src/app/recording-view-controller.ts`      | Add `barEls` option, `setLevel()`, `resetBars()`, `levelToHeight()`                |
| `src/styles.css`                            | Remove animation/keyframes, add `height` transition, keep green color              |
| `src/app/recording-view-controller.test.ts` | Add `levelToHeight` and `setLevel` tests, update `makeController`                  |

## Out of Scope

- `AnalyserNode` / `requestAnimationFrame` approach (chose simpler RMS callback)
- Full waveform or spectrogram visualization
- Persisting audio levels or peak meters
- Migrating `ScriptProcessorNode` to `AudioWorklet`
