import type { AsrRuntimeConfig } from "../asr-messages";
import {
  DEFAULT_ASR_RUNTIME_CONFIG,
  sanitizeAsrRuntimeConfig,
  type PartialAsrRuntimeConfig,
} from "./runtime-config";

export interface AsrSettings {
  silenceRms: number;
  silencePeak: number;
  silenceHangoverMs: number;
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
  silenceRms: "toru.silence.rms",
  silencePeak: "toru.silence.peak",
  silenceHangoverMs: "toru.silence.hangover.ms",
  ortThreads: "toru.asr.ort.threads",
  beamSearchEnabled: "toru.asr.decode.beam.enabled",
  beamWidth: "toru.asr.decode.beam.width",
  lmAlpha: "toru.asr.decode.lm.alpha",
  lmBeta: "toru.asr.decode.lm.beta",
  minTokenLogp: "toru.asr.decode.min.token.logp",
  beamPruneLogp: "toru.asr.decode.beam.prune.logp",
} as const;

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  silenceRms: 0.0025,
  silencePeak: 0.012,
  silenceHangoverMs: 500,
  runtimeConfig: DEFAULT_ASR_RUNTIME_CONFIG,
};

function toNumber(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(raw: string | null): boolean | undefined {
  if (raw === null) {
    return undefined;
  }
  if (raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return undefined;
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
  return {
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
    silenceHangoverMs: intWithFallback(
      input?.silenceHangoverMs,
      DEFAULT_ASR_SETTINGS.silenceHangoverMs,
      100,
      2000,
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
    silenceRms: toNumber(target.getItem(STORAGE_KEYS.silenceRms)),
    silencePeak: toNumber(target.getItem(STORAGE_KEYS.silencePeak)),
    silenceHangoverMs: toNumber(target.getItem(STORAGE_KEYS.silenceHangoverMs)),
    runtimeConfig: {
      ortThreads: toNumber(target.getItem(STORAGE_KEYS.ortThreads)),
      decode: {
        beamSearchEnabled: toBoolean(
          target.getItem(STORAGE_KEYS.beamSearchEnabled),
        ),
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

  target.setItem(STORAGE_KEYS.silenceRms, String(normalized.silenceRms));
  target.setItem(STORAGE_KEYS.silencePeak, String(normalized.silencePeak));
  target.setItem(
    STORAGE_KEYS.silenceHangoverMs,
    String(normalized.silenceHangoverMs),
  );
  target.setItem(
    STORAGE_KEYS.ortThreads,
    String(normalized.runtimeConfig.ortThreads),
  );
  target.setItem(
    STORAGE_KEYS.beamSearchEnabled,
    normalized.runtimeConfig.decode.beamSearchEnabled ? "1" : "0",
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
