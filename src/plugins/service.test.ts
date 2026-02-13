import { describe, expect, it } from "vitest";

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
});
