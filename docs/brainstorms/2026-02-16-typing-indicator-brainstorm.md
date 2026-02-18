# Typing Indicator During Recording

**Date:** 2026-02-16
**Status:** Ready for planning

## What We're Building

An animated typing dots indicator (…) that appears in the transcript textarea
when recording starts, signaling to the user that transcription text is on its
way. The dots appear immediately when the user hits Transcribe and disappear
permanently once the first chunk of transcript text arrives.

## Why This Approach

The current flow has a confusing dead zone: after hitting Transcribe, the
textarea sits empty for ~6 seconds while the first audio chunk is captured and
processed by the ASR model. There's no visual feedback that anything is
happening — the waveform bars animate, but the text area where the user is
looking gives no signal. A chat-style typing dots indicator is a universally
understood pattern that sets the expectation: "text is coming here."

## Key Decisions

- **Typing dots (…), not a status line or pulsing placeholder.** Feels native
  and familiar — matches the "text is about to appear" mental model.
- **Only during the initial wait.** Dots show when recording starts and hide
  once the first text arrives. They do NOT reappear between subsequent chunks.
  Keeps the UI calm and avoids distraction once the user is reading along.
- **Inside the transcript area.** The indicator should appear where the text
  will actually land, not in a separate status bar.

## Open Questions

- Exact animation style (bouncing dots vs fading dots vs simple ellipsis pulse)
  — to be decided during implementation.
