import type { AsrRuntimeConfig } from "../asr-messages";
import {
  DEFAULT_ASR_RUNTIME_CONFIG,
  sanitizeAsrRuntimeConfig,
  type PartialAsrRuntimeConfig,
} from "./runtime-config";

export interface AsrSettings {
  chunkSecs: number;
  strideSecs: number;
  silenceRms: number;
  silencePeak: number;
  silenceHoldChunks: number;
  silenceProbeEvery: number;
  runtimeConfig: AsrRuntimeConfig;
}

export type PartialAsrSettings = Partial<Omit<AsrSettings, "runtimeConfig">> & {
  runtimeConfig?: PartialAsrRuntimeConfig;
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEYS = {
  chunkSecs: "toru.chunk.secs",
  strideSecs: "toru.stride.secs",
  silenceRms: "toru.silence.rms",
  silencePeak: "toru.silence.peak",
  silenceHoldChunks: "toru.silence.hold.chunks",
  silenceProbeEvery: "toru.silence.probe.every",
  ortThreads: "toru.asr.ort.threads",
  beamWidth: "toru.asr.decode.beam.width",
  lmAlpha: "toru.asr.decode.lm.alpha",
  lmBeta: "toru.asr.decode.lm.beta",
  minTokenLogp: "toru.asr.decode.min.token.logp",
  beamPruneLogp: "toru.asr.decode.beam.prune.logp",
} as const;

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  chunkSecs: 6,
  strideSecs: 1.5,
  silenceRms: 0.0025,
  silencePeak: 0.012,
  silenceHoldChunks: 2,
  silenceProbeEvery: 8,
  runtimeConfig: DEFAULT_ASR_RUNTIME_CONFIG,
};

function toNumber(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberWithFallback(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function intWithFallback(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.round(numberWithFallback(value, fallback, min, max));
}

export function sanitizeAsrSettings(
  input: PartialAsrSettings | undefined,
): AsrSettings {
  const chunkSecs = numberWithFallback(
    input?.chunkSecs,
    DEFAULT_ASR_SETTINGS.chunkSecs,
    2,
    20,
  );
  const strideMax = Math.max(0.5, chunkSecs - 0.5);
  const strideFallback = Math.min(DEFAULT_ASR_SETTINGS.strideSecs, strideMax);

  return {
    chunkSecs,
    strideSecs: numberWithFallback(
      input?.strideSecs,
      strideFallback,
      0.5,
      strideMax,
    ),
    silenceRms: numberWithFallback(
      input?.silenceRms,
      DEFAULT_ASR_SETTINGS.silenceRms,
      0.0001,
      0.05,
    ),
    silencePeak: numberWithFallback(
      input?.silencePeak,
      DEFAULT_ASR_SETTINGS.silencePeak,
      0.0001,
      0.2,
    ),
    silenceHoldChunks: intWithFallback(
      input?.silenceHoldChunks,
      DEFAULT_ASR_SETTINGS.silenceHoldChunks,
      0,
      12,
    ),
    silenceProbeEvery: intWithFallback(
      input?.silenceProbeEvery,
      DEFAULT_ASR_SETTINGS.silenceProbeEvery,
      1,
      50,
    ),
    runtimeConfig: sanitizeAsrRuntimeConfig(input?.runtimeConfig),
  };
}

export function readAsrSettings(
  storage: Pick<StorageLike, "getItem">,
): AsrSettings;
export function readAsrSettings(): AsrSettings;
export function readAsrSettings(
  storage?: Pick<StorageLike, "getItem">,
): AsrSettings {
  const target = storage ?? window.localStorage;

  return sanitizeAsrSettings({
    chunkSecs: toNumber(target.getItem(STORAGE_KEYS.chunkSecs)),
    strideSecs: toNumber(target.getItem(STORAGE_KEYS.strideSecs)),
    silenceRms: toNumber(target.getItem(STORAGE_KEYS.silenceRms)),
    silencePeak: toNumber(target.getItem(STORAGE_KEYS.silencePeak)),
    silenceHoldChunks: toNumber(target.getItem(STORAGE_KEYS.silenceHoldChunks)),
    silenceProbeEvery: toNumber(target.getItem(STORAGE_KEYS.silenceProbeEvery)),
    runtimeConfig: {
      ortThreads: toNumber(target.getItem(STORAGE_KEYS.ortThreads)),
      decode: {
        beamWidth: toNumber(target.getItem(STORAGE_KEYS.beamWidth)),
        lmAlpha: toNumber(target.getItem(STORAGE_KEYS.lmAlpha)),
        lmBeta: toNumber(target.getItem(STORAGE_KEYS.lmBeta)),
        minTokenLogp: toNumber(target.getItem(STORAGE_KEYS.minTokenLogp)),
        beamPruneLogp: toNumber(target.getItem(STORAGE_KEYS.beamPruneLogp)),
      },
    },
  });
}

export function writeAsrSettings(
  settings: AsrSettings,
  storage: Pick<StorageLike, "setItem">,
): void;
export function writeAsrSettings(settings: AsrSettings): void;
export function writeAsrSettings(
  settings: AsrSettings,
  storage?: Pick<StorageLike, "setItem">,
): void {
  const target = storage ?? window.localStorage;
  const normalized = sanitizeAsrSettings(settings);

  target.setItem(STORAGE_KEYS.chunkSecs, String(normalized.chunkSecs));
  target.setItem(STORAGE_KEYS.strideSecs, String(normalized.strideSecs));
  target.setItem(STORAGE_KEYS.silenceRms, String(normalized.silenceRms));
  target.setItem(STORAGE_KEYS.silencePeak, String(normalized.silencePeak));
  target.setItem(
    STORAGE_KEYS.silenceHoldChunks,
    String(normalized.silenceHoldChunks),
  );
  target.setItem(
    STORAGE_KEYS.silenceProbeEvery,
    String(normalized.silenceProbeEvery),
  );
  target.setItem(
    STORAGE_KEYS.ortThreads,
    String(normalized.runtimeConfig.ortThreads),
  );
  target.setItem(
    STORAGE_KEYS.beamWidth,
    String(normalized.runtimeConfig.decode.beamWidth),
  );
  target.setItem(
    STORAGE_KEYS.lmAlpha,
    String(normalized.runtimeConfig.decode.lmAlpha),
  );
  target.setItem(
    STORAGE_KEYS.lmBeta,
    String(normalized.runtimeConfig.decode.lmBeta),
  );
  target.setItem(
    STORAGE_KEYS.minTokenLogp,
    String(normalized.runtimeConfig.decode.minTokenLogp),
  );
  target.setItem(
    STORAGE_KEYS.beamPruneLogp,
    String(normalized.runtimeConfig.decode.beamPruneLogp),
  );
}
