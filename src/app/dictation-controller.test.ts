import { describe, expect, it } from "vitest";

import { mergeChunkText } from "./dictation-controller";

describe("mergeChunkText", () => {
  it("returns next when current is empty", () => {
    expect(mergeChunkText("", "hello world")).toBe("hello world");
  });

  it("returns current when next is empty or whitespace", () => {
    expect(mergeChunkText("hello", "   ")).toBe("hello");
    expect(mergeChunkText("hello", "")).toBe("hello");
  });

  it("appends non-overlapping text", () => {
    expect(mergeChunkText("the patient", "reports pain")).toBe(
      "the patient reports pain",
    );
  });

  it("deduplicates overlapping suffix and prefix", () => {
    expect(mergeChunkText("the patient reports", "reports chest pain")).toBe(
      "the patient reports chest pain",
    );
  });

  it("handles multi-word overlap", () => {
    expect(
      mergeChunkText("the patient reports chest", "reports chest pain today"),
    ).toBe("the patient reports chest pain today");
  });

  it("handles single-word overlap", () => {
    expect(mergeChunkText("hello", "hello world")).toBe("hello world");
  });

  it("returns current when next is fully overlapping", () => {
    expect(mergeChunkText("hello world", "hello world")).toBe("hello world");
  });

  it("handles overlap with punctuation differences", () => {
    expect(mergeChunkText("blood pressure,", "pressure is normal")).toBe(
      "blood pressure, is normal",
    );
  });

  it("trims whitespace from next text", () => {
    expect(mergeChunkText("hello", "  world  ")).toBe("hello world");
  });

  it("avoids weak single-word dedupe on short tokens", () => {
    expect(mergeChunkText("patient is", "is resting")).toBe(
      "patient is is resting",
    );
  });

  it("stitches split words using char overlap", () => {
    expect(mergeChunkText("hypertens", "tension noted")).toBe(
      "hypertension noted",
    );
  });
});
