import { describe, expect, it } from "vitest";

import { BUILTIN_ORT_ASR_PLUGIN } from "./contracts";
import { createRuntimeAdapter } from "./runtime-adapter";

const OPTIONS = {
  workerUrl: new URL("http://localhost/asr.worker.ts"),
  ortDir: "ort/",
  appDataDir: "",
  appOrigin: "http://localhost/",
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
});
