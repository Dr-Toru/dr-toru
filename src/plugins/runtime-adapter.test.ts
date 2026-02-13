import { describe, expect, it } from "vitest";

import { BUILTIN_ORT_ASR_PLUGIN, type PluginManifest } from "./contracts";
import { createRuntimeAdapter } from "./runtime-adapter";

const OPTIONS = {
  workerUrl: new URL("http://localhost/asr.worker.ts"),
  assetBaseUrl: "http://localhost/",
  ortDir: "http://localhost/ort/",
  events: {
    onStatus: () => undefined,
    onCrash: () => undefined,
  },
};

function makeAsrManifest(overrides: Partial<PluginManifest>): PluginManifest {
  return {
    ...BUILTIN_ORT_ASR_PLUGIN,
    pluginId: "test.asr.ort.runtime-adapter",
    ...overrides,
  };
}

describe("runtime adapter", () => {
  it("creates ORT adapter for valid ASR plugin manifest", () => {
    const adapter = createRuntimeAdapter(BUILTIN_ORT_ASR_PLUGIN, OPTIONS);
    expect(adapter).toBeDefined();
  });

  it("rejects ASR manifest without vocabPath metadata", () => {
    const manifest = makeAsrManifest({
      metadata: {},
    });

    expect(() => createRuntimeAdapter(manifest, OPTIONS)).toThrow(
      "missing metadata.vocabPath",
    );
  });

  it("rejects path traversal in ASR entrypoint", () => {
    const manifest = makeAsrManifest({
      entrypointPath: "../models/bad.onnx",
    });

    expect(() => createRuntimeAdapter(manifest, OPTIONS)).toThrow(
      "Asset path cannot contain '..'",
    );
  });

  it("rejects path traversal in vocab path metadata", () => {
    const manifest = makeAsrManifest({
      metadata: {
        vocabPath: "../models/bad_vocab.json",
      },
    });

    expect(() => createRuntimeAdapter(manifest, OPTIONS)).toThrow(
      "Asset path cannot contain '..'",
    );
  });
});
