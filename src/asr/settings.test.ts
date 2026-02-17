import { describe, expect, it } from "vitest";

import {
  DEFAULT_ASR_SETTINGS,
  readAsrSettings,
  sanitizeAsrSettings,
  writeAsrSettings,
} from "./settings";

function createMemoryStorage(seed: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  snapshot: () => Record<string, string>;
} {
  const state = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => state.get(key) ?? null,
    setItem: (key, value) => {
      state.set(key, value);
    },
    snapshot: () => Object.fromEntries(state),
  };
}

describe("sanitizeAsrSettings", () => {
  it("enforces stride bound relative to chunk size", () => {
    const settings = sanitizeAsrSettings({
      chunkSecs: 2,
      strideSecs: 5,
    });

    expect(settings.chunkSecs).toBe(2);
    expect(settings.strideSecs).toBe(1.5);
  });

  it("clamps invalid numeric values", () => {
    const settings = sanitizeAsrSettings({
      silenceRms: -1,
      silencePeak: 999,
      silenceHoldChunks: 500,
      silenceProbeEvery: 0,
    });

    expect(settings.silenceRms).toBe(0.0001);
    expect(settings.silencePeak).toBe(0.2);
    expect(settings.silenceHoldChunks).toBe(12);
    expect(settings.silenceProbeEvery).toBe(1);
  });
});

describe("readAsrSettings", () => {
  it("returns defaults for empty storage", () => {
    const storage = createMemoryStorage();
    expect(readAsrSettings(storage)).toEqual(DEFAULT_ASR_SETTINGS);
  });

  it("falls back on non-numeric values", () => {
    const storage = createMemoryStorage({
      "toru.chunk.secs": "nope",
      "toru.asr.decode.beam.width": "n/a",
    });

    const settings = readAsrSettings(storage);
    expect(settings.chunkSecs).toBe(DEFAULT_ASR_SETTINGS.chunkSecs);
    expect(settings.runtimeConfig.decode.beamWidth).toBe(
      DEFAULT_ASR_SETTINGS.runtimeConfig.decode.beamWidth,
    );
  });
});

describe("writeAsrSettings", () => {
  it("persists a sanitized round-trip", () => {
    const storage = createMemoryStorage();

    writeAsrSettings(
      {
        ...DEFAULT_ASR_SETTINGS,
        chunkSecs: 30,
        strideSecs: 30,
        runtimeConfig: {
          ...DEFAULT_ASR_SETTINGS.runtimeConfig,
          decode: {
            ...DEFAULT_ASR_SETTINGS.runtimeConfig.decode,
            beamWidth: 64,
          },
        },
      },
      storage,
    );

    const loaded = readAsrSettings(storage);
    expect(loaded.chunkSecs).toBe(20);
    expect(loaded.strideSecs).toBe(19.5);
    expect(loaded.runtimeConfig.decode.beamWidth).toBe(32);

    const snapshot = storage.snapshot();
    expect(snapshot["toru.chunk.secs"]).toBe("20");
    expect(snapshot["toru.stride.secs"]).toBe("19.5");
    expect(snapshot["toru.asr.decode.beam.width"]).toBe("32");
  });
});
