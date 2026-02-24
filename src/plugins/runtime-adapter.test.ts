import { describe, expect, it } from "vitest";

import { DEFAULT_ASR_RUNTIME_CONFIG } from "../asr/runtime-config";
import type { PluginManifest } from "./contracts";
import { createRuntimeAdapter } from "./runtime-adapter";

const ORT_ASR_MANIFEST: PluginManifest = {
  pluginId: "import.asr.ort.test",
  name: "Test ASR",
  version: "1.0.0",
  kind: "asr",
  runtime: "ort-ctc",
  entrypointPath: "/tmp/model.onnx",
  hash: "a".repeat(64),
  metadata: {
    vocabPath: "/tmp/vocab.json",
  },
};

const OPTIONS = {
  workerUrl: new URL("http://localhost/asr.worker.ts"),
  ortDir: "ort/",
  appDataDir: "",
  appOrigin: "http://localhost/",
  asrRuntimeConfig: DEFAULT_ASR_RUNTIME_CONFIG,
  events: {
    onStatus: () => undefined,
    onCrash: () => undefined,
  },
};

describe("runtime adapter", () => {
  it("creates ORT runtime for valid ASR manifest", () => {
    const adapter = createRuntimeAdapter(ORT_ASR_MANIFEST, OPTIONS);
    expect(adapter).toBeDefined();
  });

  it("fails fast when ASR vocab metadata is missing", () => {
    expect(() =>
      createRuntimeAdapter(
        {
          ...ORT_ASR_MANIFEST,
          pluginId: "bad.asr.runtime-missing-vocab",
          metadata: {},
        },
        OPTIONS,
      ),
    ).toThrowError(/metadata\.vocabPath/);
  });

  it("rejects unsupported ASR runtime values", () => {
    expect(() =>
      createRuntimeAdapter(
        {
          ...ORT_ASR_MANIFEST,
          pluginId: "bad.asr.runtime-unknown",
          runtime: "custom-runtime",
        },
        OPTIONS,
      ),
    ).toThrowError(/Unsupported ASR runtime/);
  });

  it("rejects whisper runtime in web mode", () => {
    expect(() =>
      createRuntimeAdapter(
        {
          ...ORT_ASR_MANIFEST,
          pluginId: "bad.asr.runtime-whisper-web",
          runtime: "whisper",
          metadata: {},
        },
        OPTIONS,
      ),
    ).toThrowError(/only supported in native desktop mode/);
  });

  it("applies custom runtime config to ORT ASR plugins", () => {
    const tunedOptions = {
      ...OPTIONS,
      asrRuntimeConfig: {
        ortThreads: 2,
        decode: {
          beamSearchEnabled: true,
          beamWidth: 16,
          lmAlpha: 0.9,
          lmBeta: 2.1,
          minTokenLogp: -3,
          beamPruneLogp: -7,
        },
      },
    };

    const adapter = createRuntimeAdapter(
      {
        ...ORT_ASR_MANIFEST,
        pluginId: "import.asr.ort.custom",
      },
      tunedOptions,
    ) as unknown as { asrRuntimeConfig: typeof tunedOptions.asrRuntimeConfig };
    expect(adapter.asrRuntimeConfig.decode.beamSearchEnabled).toBe(true);
    expect(adapter.asrRuntimeConfig.ortThreads).toBe(2);
  });

  it("preserves default runtime config values passed by caller", () => {
    const adapter = createRuntimeAdapter(
      ORT_ASR_MANIFEST,
      OPTIONS,
    ) as unknown as { asrRuntimeConfig: typeof OPTIONS.asrRuntimeConfig };
    expect(adapter.asrRuntimeConfig.decode.beamSearchEnabled).toBe(
      DEFAULT_ASR_RUNTIME_CONFIG.decode.beamSearchEnabled,
    );
    expect(adapter.asrRuntimeConfig.ortThreads).toBe(
      DEFAULT_ASR_RUNTIME_CONFIG.ortThreads,
    );
  });
});
