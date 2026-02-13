import { describe, expect, it } from "vitest";

import { PluginPlatform } from "./platform";
import { NoopPluginRegistryStore } from "./store";

function createPlatform(): PluginPlatform {
  return new PluginPlatform(new NoopPluginRegistryStore(), {
    workerUrl: new URL("http://localhost/asr.worker.ts"),
    assetBaseUrl: "http://localhost/",
    ortDir: "ort/",
    asrEvents: {
      onStatus: () => undefined,
      onCrash: () => undefined,
    },
  });
}

describe("PluginPlatform", () => {
  it("initializes with built-in ASR and no transform provider", async () => {
    const platform = createPlatform();
    const state = await platform.init();

    expect(state.ready).toBe(true);
    expect(state.error).toBeNull();
    expect(state.activeAsr?.pluginId).toBe("builtin.asr.ort.medasr");
    expect(state.activeTransform).toBeNull();
    expect(state.transformRunning).toBe(false);
  });

  it("reports import capability from runtime", async () => {
    const platform = createPlatform();
    const state = await platform.init();

    expect(state.canImport).toBe(false);
  });
});
