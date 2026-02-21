import { describe, expect, it } from "vitest";

import { NoopPluginRegistryStore } from "./store";

describe("NoopPluginRegistryStore", () => {
  it("imports .llamafile entries", async () => {
    const store = new NoopPluginRegistryStore();

    const manifest = await store.importFromPath({
      sourcePath: "/tmp/test.llamafile",
      displayName: "Test LLM",
    });

    expect(manifest.kind).toBe("llm");
    expect(manifest.runtime).toBe("llamafile");
    expect(manifest.name).toBe("Test LLM");
  });

  it("rejects .zip import in noop runtime", async () => {
    const store = new NoopPluginRegistryStore();

    await expect(
      store.importFromPath({ sourcePath: "/tmp/asr-package.zip" }),
    ).rejects.toThrowError(
      /Zip package import is only available in desktop runtime/,
    );
  });

  it("rejects unsupported extensions", async () => {
    const store = new NoopPluginRegistryStore();

    await expect(
      store.importFromPath({ sourcePath: "/tmp/model.onnx" }),
    ).rejects.toThrowError(/Only \.llamafile and \.zip imports are supported/);
  });
});
