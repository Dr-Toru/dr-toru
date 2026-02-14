import { describe, expect, it } from "vitest";

import { BUILTIN_ORT_ASR_PLUGIN } from "./contracts";
import { PluginService } from "./service";
import { NoopPluginRegistryStore } from "./store";

describe("PluginService", () => {
  it("resolves builtin ASR provider by default", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr?.pluginId).toBe("builtin.asr.ort.medasr");
  });

  it("reports no active llm by default", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    const activeLlm = await service.activePlugin("llm");
    expect(activeLlm).toBeNull();
  });

  it("allows imported ONNX provider to become active ASR", async () => {
    const store = new NoopPluginRegistryStore();
    const service = new PluginService(store);
    await service.init();

    await store.add({
      ...BUILTIN_ORT_ASR_PLUGIN,
      pluginId: "import.asr.ort.test",
      name: "Imported ASR",
      entrypointPath: "/tmp/test.onnx",
      sha256: "1".repeat(64),
    });

    await service.setActivePlugin("asr", "import.asr.ort.test");

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr?.pluginId).toBe("import.asr.ort.test");
  });

  it("allows ASR provider to be unset", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    await service.setActivePlugin("asr", null);

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr).toBeNull();
  });
});
