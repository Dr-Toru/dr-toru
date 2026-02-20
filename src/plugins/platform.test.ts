import { describe, expect, it } from "vitest";

import { DEFAULT_ASR_RUNTIME_CONFIG } from "../asr/runtime-config";
import { PluginPlatform } from "./platform";
import { NoopPluginRegistryStore } from "./store";

function createPlatform(store = new NoopPluginRegistryStore()): PluginPlatform {
  return new PluginPlatform(store, {
    workerUrl: new URL("http://localhost/asr.worker.ts"),
    ortDir: "ort/",
    appOrigin: "http://localhost/",
    asrRuntimeConfig: DEFAULT_ASR_RUNTIME_CONFIG,
    asrEvents: {
      onStatus: () => undefined,
      onCrash: () => undefined,
    },
  });
}

describe("PluginPlatform", () => {
  it("initializes with built-in ASR and no LLM provider", async () => {
    const platform = createPlatform();
    const state = await platform.init();

    expect(state.ready).toBe(true);
    expect(state.error).toBeNull();
    expect(state.features.transcription).toBe(true);
    expect(state.features.llm).toBe(false);
    expect(state.activeAsr?.pluginId).toBe("builtin.asr.ort.medasr");
    expect(state.activeLlm).toBeNull();
    expect(state.llmRunning).toBe(false);
  });

  it("reports import capability from runtime", async () => {
    const platform = createPlatform();
    const state = await platform.init();

    expect(state.canImport).toBe(false);
  });

  it("tracks unloaded capability states by default", async () => {
    const platform = createPlatform();
    await platform.init();

    expect(platform.getAsrLoadState()).toBe("unloaded");
    expect(platform.getLlmLoadState()).toBe("unloaded");
    expect(platform.isLlmBusy()).toBe(false);
  });

  it("allows no-op unload when no LLM provider is active", async () => {
    const platform = createPlatform();
    await platform.init();

    await expect(platform.setLlmLoaded(false)).resolves.toBeUndefined();
    expect(platform.getLlmLoadState()).toBe("unloaded");
  });

  it("setActivePlugin unloads before switching", async () => {
    const platform = createPlatform();
    await platform.init();
    const state = await platform.setActivePlugin("asr", null);
    expect(state.features.transcription).toBe(false);
    expect(platform.getAsrLoadState()).toBe("unloaded");
  });

  it("stays initialized when no ASR provider is active", async () => {
    const store = new NoopPluginRegistryStore();
    await store.setActivePlugin("asr", null);
    const platform = createPlatform(store);
    const state = await platform.init();

    expect(state.ready).toBe(true);
    expect(state.error).toBeNull();
    expect(state.features.transcription).toBe(false);
    expect(state.activeAsr).toBeNull();
  });
});
