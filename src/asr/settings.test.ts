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
  it("clamps invalid numeric values", () => {
    const settings = sanitizeAsrSettings({
      silenceRms: -1,
      silencePeak: 999,
      silenceHangoverMs: 5000,
    });

    expect(settings.silenceRms).toBe(0.0001);
    expect(settings.silencePeak).toBe(0.2);
    expect(settings.silenceHangoverMs).toBe(2000);
  });

  it("uses defaults for undefined input", () => {
    const settings = sanitizeAsrSettings(undefined);
    expect(settings).toEqual(DEFAULT_ASR_SETTINGS);
  });

  it("clamps silenceHangoverMs to valid range", () => {
    expect(
      sanitizeAsrSettings({ silenceHangoverMs: 50 }).silenceHangoverMs,
    ).toBe(100);
    expect(
      sanitizeAsrSettings({ silenceHangoverMs: 3000 }).silenceHangoverMs,
    ).toBe(2000);
    expect(
      sanitizeAsrSettings({ silenceHangoverMs: 750 }).silenceHangoverMs,
    ).toBe(750);
  });
});

describe("readAsrSettings", () => {
  it("returns defaults for empty storage", () => {
    const storage = createMemoryStorage();
    expect(readAsrSettings(storage)).toEqual(DEFAULT_ASR_SETTINGS);
  });

  it("falls back on non-numeric values", () => {
    const storage = createMemoryStorage({
      "toru.silence.hangover.ms": "nope",
      "toru.asr.decode.beam.width": "n/a",
      "toru.asr.decode.beam.enabled": "wat",
    });

    const settings = readAsrSettings(storage);
    expect(settings.runtimeConfig.decode.beamSearchEnabled).toBe(
      DEFAULT_ASR_SETTINGS.runtimeConfig.decode.beamSearchEnabled,
    );
    expect(settings.silenceHangoverMs).toBe(
      DEFAULT_ASR_SETTINGS.silenceHangoverMs,
    );
    expect(settings.runtimeConfig.decode.beamWidth).toBe(
      DEFAULT_ASR_SETTINGS.runtimeConfig.decode.beamWidth,
    );
  });

  it("gracefully ignores old localStorage keys", () => {
    const storage = createMemoryStorage({
      "toru.chunk.secs": "6",
      "toru.stride.secs": "1.5",
      "toru.silence.hold.chunks": "2",
      "toru.silence.probe.every": "8",
    });

    const settings = readAsrSettings(storage);
    expect(settings).toEqual(DEFAULT_ASR_SETTINGS);
  });
});

describe("writeAsrSettings", () => {
  it("persists a sanitized round-trip", () => {
    const storage = createMemoryStorage();

    writeAsrSettings(
      {
        ...DEFAULT_ASR_SETTINGS,
        silenceHangoverMs: 800,
        runtimeConfig: {
          ...DEFAULT_ASR_SETTINGS.runtimeConfig,
          decode: {
            ...DEFAULT_ASR_SETTINGS.runtimeConfig.decode,
            beamSearchEnabled: false,
            beamWidth: 64,
          },
        },
      },
      storage,
    );

    const loaded = readAsrSettings(storage);
    expect(loaded.silenceHangoverMs).toBe(800);
    expect(loaded.runtimeConfig.decode.beamSearchEnabled).toBe(false);
    expect(loaded.runtimeConfig.decode.beamWidth).toBe(32);

    const snapshot = storage.snapshot();
    expect(snapshot["toru.silence.hangover.ms"]).toBe("800");
    expect(snapshot["toru.asr.decode.beam.enabled"]).toBe("0");
    expect(snapshot["toru.asr.decode.beam.width"]).toBe("32");
  });
});
