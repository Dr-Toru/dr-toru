import { describe, expect, it } from "vitest";

import {
  DEFAULT_ASR_RUNTIME_CONFIG,
  sanitizeAsrRuntimeConfig,
} from "./runtime-config";

describe("sanitizeAsrRuntimeConfig", () => {
  it("returns defaults for empty input", () => {
    expect(sanitizeAsrRuntimeConfig(undefined)).toEqual(
      DEFAULT_ASR_RUNTIME_CONFIG,
    );
  });

  it("clamps and rounds out-of-range values", () => {
    expect(
      sanitizeAsrRuntimeConfig({
        ortThreads: 99,
        decode: {
          beamWidth: 0.2,
          lmAlpha: -1,
          lmBeta: 99,
          minTokenLogp: -100,
          beamPruneLogp: 4,
        },
      }),
    ).toEqual({
      ortThreads: 8,
      decode: {
        beamWidth: 1,
        lmAlpha: 0,
        lmBeta: 5,
        minTokenLogp: -20,
        beamPruneLogp: 0,
      },
    });
  });

  it("preserves valid values", () => {
    expect(
      sanitizeAsrRuntimeConfig({
        ortThreads: 3,
        decode: {
          beamWidth: 12,
          lmAlpha: 0.7,
          lmBeta: 2.1,
          minTokenLogp: -4.5,
          beamPruneLogp: -8,
        },
      }),
    ).toEqual({
      ortThreads: 3,
      decode: {
        beamWidth: 12,
        lmAlpha: 0.7,
        lmBeta: 2.1,
        minTokenLogp: -4.5,
        beamPruneLogp: -8,
      },
    });
  });
});
