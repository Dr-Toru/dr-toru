import { describe, expect, it } from "vitest";

import {
  BUILTIN_ORT_ASR_PLUGIN,
  canProvideRole,
  supportsFeature,
  validatePluginManifest,
  type PluginManifest,
} from "./contracts";

describe("plugin contracts", () => {
  it("accepts builtin ORT ASR manifest", () => {
    const issues = validatePluginManifest(BUILTIN_ORT_ASR_PLUGIN);
    expect(issues).toHaveLength(0);
    expect(canProvideRole(BUILTIN_ORT_ASR_PLUGIN, "asr")).toBe(true);
    expect(canProvideRole(BUILTIN_ORT_ASR_PLUGIN, "transform")).toBe(false);
  });

  it("rejects incompatible runtime for ASR", () => {
    const manifest: PluginManifest = {
      ...BUILTIN_ORT_ASR_PLUGIN,
      pluginId: "bad.asr.llamafile",
      runtime: "llamafile",
    };

    const issues = validatePluginManifest(manifest);
    expect(issues.some((issue) => issue.field === "runtime")).toBe(true);
  });

  it("rejects unknown capabilities", () => {
    const manifest = {
      ...BUILTIN_ORT_ASR_PLUGIN,
      pluginId: "bad.capability",
      capabilities: ["asr.stream", "asr.unknown"],
    } as unknown as PluginManifest;

    const issues = validatePluginManifest(manifest);
    expect(issues.some((issue) => issue.field === "capabilities")).toBe(true);
  });

  it("maps features to role capabilities", () => {
    expect(supportsFeature(BUILTIN_ORT_ASR_PLUGIN, "transcription")).toBe(true);
    expect(supportsFeature(BUILTIN_ORT_ASR_PLUGIN, "transform")).toBe(false);
    expect(supportsFeature(null, "transcription")).toBe(false);
  });
});
