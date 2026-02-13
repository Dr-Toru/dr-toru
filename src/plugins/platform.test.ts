import { describe, expect, it } from "vitest";

import { PluginPlatform } from "./platform";
import { NoopPluginRegistryStore } from "./store";

function createPlatform(store = new NoopPluginRegistryStore()): PluginPlatform {
  return new PluginPlatform(store, {
    workerUrl: new URL("http://localhost/asr.worker.ts"),
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
    expect(state.features.transcription).toBe(true);
    expect(state.features.transform).toBe(false);
    expect(state.activeAsr?.pluginId).toBe("builtin.asr.ort.medasr");
    expect(state.activeTransform).toBeNull();
    expect(state.transformRunning).toBe(false);
  });

  it("reports import capability from runtime", async () => {
    const platform = createPlatform();
    const state = await platform.init();

    expect(state.canImport).toBe(false);
  });

  it("stays initialized when no ASR provider is active", async () => {
    const store = new NoopPluginRegistryStore();
    await store.setActiveProvider("asr", null);
    const platform = createPlatform(store);
    const state = await platform.init();

    expect(state.ready).toBe(true);
    expect(state.error).toBeNull();
    expect(state.features.transcription).toBe(false);
    expect(state.activeAsr).toBeNull();
  });
});
