import { describe, expect, it } from "vitest";

import { chunkAudio } from "./chunk";

describe("chunkAudio", () => {
  it("returns empty array for empty audio", () => {
    expect(chunkAudio(new Float32Array(), 16000)).toEqual([]);
  });

  it("returns single chunk when audio is shorter than chunk length", () => {
    const samples = new Float32Array(16000 * 10); // 10 seconds
    const chunks = chunkAudio(samples, 16000, 20, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(samples); // same reference (subarray of full buffer)
  });

  it("returns single chunk when audio is exactly chunk length", () => {
    const samples = new Float32Array(16000 * 20); // exactly 20 seconds
    const chunks = chunkAudio(samples, 16000, 20, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(samples);
  });

  it("chunks audio with correct overlap", () => {
    // 40 seconds of audio at 16kHz with 20s chunks and 2s stride
    const sampleRate = 16000;
    const samples = new Float32Array(sampleRate * 40);
    // Fill with sequential values for verification
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i;
    }

    const chunks = chunkAudio(samples, sampleRate, 20, 2);

    // Step = 20 - 2 = 18 seconds. Offsets: 0, 18s, 36s.
    // Chunk 0: [0, 20s), chunk 1: [18s, 38s), chunk 2: [36s, 40s)
    expect(chunks).toHaveLength(3);

    // First chunk: 0 to 20s
    expect(chunks[0].length).toBe(sampleRate * 20);
    expect(chunks[0][0]).toBe(0);

    // Second chunk: 18s to 38s
    expect(chunks[1].length).toBe(sampleRate * 20);
    expect(chunks[1][0]).toBe(sampleRate * 18);

    // Third chunk: 36s to 40s (remainder)
    expect(chunks[2].length).toBe(sampleRate * 4);
    expect(chunks[2][0]).toBe(sampleRate * 36);
  });

  it("handles audio just over one chunk length", () => {
    const sampleRate = 100; // small rate for easy math
    const samples = new Float32Array(2100); // 21 seconds at 100Hz
    const chunks = chunkAudio(samples, sampleRate, 20, 2);

    // Step = 18s = 1800 samples. Chunk 0: [0, 2000), chunk 1: [1800, 2100)
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(300); // 2100 - 1800
  });

  it("returns views into the original buffer (no copies)", () => {
    const samples = new Float32Array(16000 * 25);
    const chunks = chunkAudio(samples, 16000, 20, 2);
    expect(chunks[0].buffer).toBe(samples.buffer);
    expect(chunks[1].buffer).toBe(samples.buffer);
  });

  it("uses default parameters when not specified", () => {
    // 60 seconds of audio - should produce multiple chunks with defaults (20s/2s)
    const samples = new Float32Array(16000 * 60);
    const chunks = chunkAudio(samples);
    // Step = 18s. Offsets: 0, 18, 36, 54. Last chunk starts at 54s, extends to 60s.
    expect(chunks).toHaveLength(4);
  });
});
