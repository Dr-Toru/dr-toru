import { describe, expect, it } from "vitest";

import { DEFAULT_ASR_RUNTIME_CONFIG } from "../asr/runtime-config";
import { BUILTIN_ORT_ASR_PLUGIN } from "./contracts";
import { createRuntimeAdapter } from "./runtime-adapter";

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
    const adapter = createRuntimeAdapter(BUILTIN_ORT_ASR_PLUGIN, OPTIONS);
    expect(adapter).toBeDefined();
  });

  it("fails fast when ASR vocab metadata is missing", () => {
    expect(() =>
      createRuntimeAdapter(
        {
          ...BUILTIN_ORT_ASR_PLUGIN,
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
          ...BUILTIN_ORT_ASR_PLUGIN,
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
          ...BUILTIN_ORT_ASR_PLUGIN,
          pluginId: "bad.asr.runtime-whisper-web",
          runtime: "whisper",
          metadata: {},
        },
        OPTIONS,
      ),
    ).toThrowError(/only supported in native desktop mode/);
  });

  it("applies custom runtime config only to built-in Med ASR", () => {
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

    const builtInAdapter = createRuntimeAdapter(
      BUILTIN_ORT_ASR_PLUGIN,
      tunedOptions,
    ) as unknown as { asrRuntimeConfig: typeof tunedOptions.asrRuntimeConfig };
    expect(builtInAdapter.asrRuntimeConfig.decode.beamSearchEnabled).toBe(true);
    expect(builtInAdapter.asrRuntimeConfig.ortThreads).toBe(2);

    const importedAdapter = createRuntimeAdapter(
      {
        ...BUILTIN_ORT_ASR_PLUGIN,
        pluginId: "import.asr.ort.custom",
      },
      tunedOptions,
    ) as unknown as { asrRuntimeConfig: typeof tunedOptions.asrRuntimeConfig };
    expect(importedAdapter.asrRuntimeConfig.decode.beamSearchEnabled).toBe(
      DEFAULT_ASR_RUNTIME_CONFIG.decode.beamSearchEnabled,
    );
    expect(importedAdapter.asrRuntimeConfig.ortThreads).toBe(
      DEFAULT_ASR_RUNTIME_CONFIG.ortThreads,
    );
  });
});
