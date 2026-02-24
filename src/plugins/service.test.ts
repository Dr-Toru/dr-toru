import { describe, expect, it } from "vitest";

import { PluginService } from "./service";
import { NoopPluginRegistryStore } from "./store";

const ORT_ASR_MANIFEST = {
  pluginId: "import.asr.ort.test",
  name: "Imported ASR",
  version: "1.0.0",
  kind: "asr" as const,
  runtime: "ort-ctc",
  entrypointPath: "/tmp/test.onnx",
  hash: "1".repeat(64),
  metadata: {
    vocabPath: "/tmp/test.vocab.json",
  },
};

describe("PluginService", () => {
  it("reports no active ASR provider by default", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    const activeAsr = await service.activePlugin("asr");
    expect(activeAsr).toBeNull();
  });

  it("reports no active llm by default", async () => {
    const service = new PluginService(new NoopPluginRegistryStore());
    await service.init();

    const activeLlm = await service.activePlugin("llm");
    expect(activeLlm).toBeNull();
  });

  it("allows imported ASR provider to become active", async () => {
    const store = new NoopPluginRegistryStore();
    const service = new PluginService(store);
    await service.init();

    await store.add(ORT_ASR_MANIFEST);

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
