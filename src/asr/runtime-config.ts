import type { AsrRuntimeConfig } from "../asr-messages";

export type PartialAsrRuntimeConfig = Partial<
  Omit<AsrRuntimeConfig, "decode">
> & {
  decode?: Partial<AsrRuntimeConfig["decode"]>;
};

export const DEFAULT_ASR_RUNTIME_CONFIG: AsrRuntimeConfig = {
  ortThreads: 1,
  decode: {
    beamSearchEnabled: false,
    beamWidth: 8,
    lmAlpha: 0.5,
    lmBeta: 1.5,
    minTokenLogp: -5,
    beamPruneLogp: -10,
  },
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function withFallback(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function withFallbackInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.round(withFallback(value, fallback, min, max));
}

function withFallbackBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function sanitizeAsrRuntimeConfig(
  input: PartialAsrRuntimeConfig | undefined,
): AsrRuntimeConfig {
  const decode = input?.decode;
  return {
    ortThreads: withFallbackInt(
      input?.ortThreads,
      DEFAULT_ASR_RUNTIME_CONFIG.ortThreads,
      1,
      2,
    ),
    decode: {
      beamSearchEnabled: withFallbackBoolean(
        decode?.beamSearchEnabled,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.beamSearchEnabled,
      ),
      beamWidth: withFallbackInt(
        decode?.beamWidth,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.beamWidth,
        1,
        32,
      ),
      lmAlpha: withFallback(
        decode?.lmAlpha,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.lmAlpha,
        0,
        3,
      ),
      lmBeta: withFallback(
        decode?.lmBeta,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.lmBeta,
        -2,
        5,
      ),
      minTokenLogp: withFallback(
        decode?.minTokenLogp,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.minTokenLogp,
        -20,
        0,
      ),
      beamPruneLogp: withFallback(
        decode?.beamPruneLogp,
        DEFAULT_ASR_RUNTIME_CONFIG.decode.beamPruneLogp,
        -30,
        0,
      ),
    },
  };
}
