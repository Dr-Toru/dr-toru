import { describe, expect, it } from "vitest";

import { mixToMono, resampleLinear } from "./upload";

interface BufferShape {
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function makeBuffer(channels: readonly Float32Array[]): BufferShape {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (channel: number) =>
      channels[channel] ?? new Float32Array(),
  };
}

describe("mixToMono", () => {
  it("returns the same content for single-channel audio", () => {
    const mono = new Float32Array([1, -2, 3]);
    const mixed = mixToMono(makeBuffer([mono]));
    expect(Array.from(mixed)).toEqual([1, -2, 3]);
  });

  it("averages multiple channels into mono", () => {
    const left = new Float32Array([0.6, 0.2, -0.4]);
    const right = new Float32Array([0.2, -0.2, 0.4]);
    const mixed = mixToMono(makeBuffer([left, right]));
    const expected = [0.4, 0.0, 0.0];
    mixed.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
  });
});

describe("resampleLinear", () => {
  it("returns a copy when sample rates match", () => {
    const source = new Float32Array([1, 3, 5]);
    const resampled = resampleLinear(source, 16000, 16000);
    expect(Array.from(resampled)).toEqual([1, 3, 5]);
    expect(resampled).not.toBe(source);
  });

  it("downsamples and preserves endpoints", () => {
    const source = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const resampled = resampleLinear(source, 8000, 4000);
    expect(Array.from(resampled)).toEqual([0, 2, 4, 6]);
  });

  it("throws on invalid rates", () => {
    expect(() => resampleLinear(new Float32Array([1]), 0, 16000)).toThrow(
      "Sample rates must be positive.",
    );
  });
});
