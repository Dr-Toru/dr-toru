import { describe, expect, it } from "vitest";

import {
  BUILTIN_ORT_ASR_PLUGIN,
  validatePluginManifest,
  type PluginManifest,
} from "./contracts";

describe("plugin contracts", () => {
  it("accepts builtin ORT ASR manifest", () => {
    const issues = validatePluginManifest(BUILTIN_ORT_ASR_PLUGIN);
    expect(issues).toHaveLength(0);
  });

  it("rejects asr manifest without vocab metadata", () => {
    const manifest: PluginManifest = {
      ...BUILTIN_ORT_ASR_PLUGIN,
      pluginId: "bad.asr.missing-vocab",
      metadata: {},
    };

    const issues = validatePluginManifest(manifest);
    expect(issues.some((issue) => issue.field === "metadata.vocabPath")).toBe(
      true,
    );
  });

  it("accepts llm manifest without vocab metadata", () => {
    const manifest: PluginManifest = {
      pluginId: "test.llm.model",
      name: "Test LLM",
      version: "1.0.0",
      kind: "llm",
      entrypointPath: "/tmp/model.llamafile",
      sha256: "a".repeat(64),
    };

    const issues = validatePluginManifest(manifest);
    expect(issues).toHaveLength(0);
  });
});
