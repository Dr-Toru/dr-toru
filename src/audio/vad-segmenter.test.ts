import { describe, expect, it } from "vitest";
import { VadSegmenter, type VadSegmenterConfig } from "./vad-segmenter";

const FRAME_SAMPLES = 2048;
const SAMPLE_RATE = 16000;

function defaultConfig(
  overrides: Partial<VadSegmenterConfig> = {},
): VadSegmenterConfig {
  return {
    sampleRate: SAMPLE_RATE,
    frameSamples: FRAME_SAMPLES,
    silenceRms: 0.0025,
    silencePeak: 0.012,
    speechOnsetMs: 150,
    silenceHangoverMs: 500,
    maxSegmentSecs: 18,
    preRollMs: 200,
    ...overrides,
  };
}

function silentFrame(): Float32Array {
  return new Float32Array(FRAME_SAMPLES);
}

function speechFrame(amplitude = 0.1): Float32Array {
  const frame = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i++) {
    frame[i] = amplitude * Math.sin(i * 0.1);
  }
  return frame;
}

function pushSpeech(seg: VadSegmenter, count: number, amplitude = 0.1): void {
  for (let i = 0; i < count; i++) {
    seg.pushFrame(speechFrame(amplitude));
  }
}

function pushSilence(seg: VadSegmenter, count: number): void {
  for (let i = 0; i < count; i++) {
    seg.pushFrame(silentFrame());
  }
}

describe("VadSegmenter", () => {
  it("emits no segments for silence only", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(defaultConfig());
    seg.start((s) => segments.push(s));

    pushSilence(seg, 20);

    expect(segments).toHaveLength(0);
    seg.stop();
  });

  it("emits a segment after speech followed by hangover silence", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(defaultConfig());
    seg.start((s) => segments.push(s));

    pushSpeech(seg, 10);
    pushSilence(seg, 10);

    expect(segments).toHaveLength(1);
    expect(segments[0].length).toBeGreaterThan(0);
    seg.stop();
  });

  it("includes pre-roll frames in emitted segment", () => {
    const segments: Float32Array[] = [];
    // preRollMs=200 at 16kHz with 2048 frames ~= 1.5 frames, rounds to 2
    const seg = new VadSegmenter(defaultConfig({ preRollMs: 200 }));
    seg.start((s) => segments.push(s));

    // Feed some silence (becomes pre-roll)
    pushSilence(seg, 5);
    // Then speech + silence to trigger emit
    pushSpeech(seg, 10);
    pushSilence(seg, 10);

    expect(segments).toHaveLength(1);
    // Segment should be larger than just the speech frames because pre-roll included
    const speechOnlySamples = 10 * FRAME_SAMPLES;
    expect(segments[0].length).toBeGreaterThan(speechOnlySamples);
    seg.stop();
  });

  it("respects onset threshold -- short blip below onset produces no segment", () => {
    const segments: Float32Array[] = [];
    // speechOnsetMs=150 at 16kHz/2048 => ~1.2 frames => 1 frame needed
    // Set higher so we need more frames
    const seg = new VadSegmenter(defaultConfig({ speechOnsetMs: 400 }));
    seg.start((s) => segments.push(s));

    // Single speech frame (below onset of ~3 frames)
    pushSpeech(seg, 1);
    pushSilence(seg, 20);

    expect(segments).toHaveLength(0);
    seg.stop();
  });

  it("keeps onset speech even when pre-roll is disabled", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(
      defaultConfig({
        speechOnsetMs: 400,
        preRollMs: 0,
        silenceHangoverMs: 512,
      }),
    );
    seg.start((s) => segments.push(s));

    pushSpeech(seg, 4);
    pushSilence(seg, 10);

    expect(segments).toHaveLength(1);
    // 4 speech frames + 4 hangover silence frames
    expect(segments[0].length).toBe(8 * FRAME_SAMPLES);
    seg.stop();
  });

  it("force-flushes and splits at energy dip for long segments", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(defaultConfig({ maxSegmentSecs: 1 }));
    seg.start((s) => segments.push(s));

    // At 16kHz, 1s = 16000 samples. With 2048 frame size, ~8 frames to fill.
    // Insert a quiet frame in the middle to serve as split point.
    pushSpeech(seg, 3, 0.1);
    pushSpeech(seg, 1, 0.02); // lower energy -- split target
    pushSpeech(seg, 6, 0.1);

    expect(segments.length).toBeGreaterThanOrEqual(1);
    // Verify no audio is lost: total emitted + remaining should equal input
    seg.flush();
    const totalEmitted = segments.reduce((sum, s) => sum + s.length, 0);
    expect(totalEmitted).toBe(10 * FRAME_SAMPLES);
    seg.stop();
  });

  it("flush emits partial segment", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(defaultConfig());
    seg.start((s) => segments.push(s));

    pushSpeech(seg, 5);
    seg.flush();

    expect(segments).toHaveLength(1);
    expect(segments[0].length).toBeGreaterThan(0);
    seg.stop();
  });

  it("emits multiple segments for separate utterances", () => {
    const segments: Float32Array[] = [];
    const seg = new VadSegmenter(defaultConfig());
    seg.start((s) => segments.push(s));

    // First utterance
    pushSpeech(seg, 10);
    pushSilence(seg, 10);

    // Second utterance
    pushSpeech(seg, 10);
    pushSilence(seg, 10);

    expect(segments).toHaveLength(2);
    seg.stop();
  });
});
