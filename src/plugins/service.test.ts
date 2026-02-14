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

  it("reports transform capability as unavailable by default", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    const hasSoap = await service.hasCapability(
      "transform",
      "llm.transform.soap",
    );
    expect(hasSoap).toBe(false);
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

    await service.setActiveProvider("asr", "import.asr.ort.test");

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr?.pluginId).toBe("import.asr.ort.test");
  });

  it("allows ASR provider to be unset", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    await service.setActiveProvider("asr", null);

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr).toBeNull();
  });
});
