export const PLUGIN_REGISTRY_FORMAT = 1 as const;

export const PLUGIN_KINDS = ["asr", "llm"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export interface PluginManifest {
  pluginId: string;
  name: string;
  version: string;
  kind: PluginKind;
  entrypointPath: string;
  sha256: string;
  modelFamily?: string;
  sizeBytes?: number;
  license?: string;
  installedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PluginRegistryState {
  format: typeof PLUGIN_REGISTRY_FORMAT;
  plugins: PluginManifest[];
  activePlugins: Record<PluginKind, string | null>;
}

export interface PluginValidationIssue {
  field: string;
  message: string;
}

export const BUILTIN_ORT_ASR_PLUGIN: PluginManifest = {
  pluginId: "builtin.asr.ort.medasr",
  name: "Built-in Medical ASR",
  version: "1.0.0",
  kind: "asr",
  entrypointPath: "models/medasr_lasr_ctc_int8.onnx",
  sha256: "05c1907f53d9dea3db23092e4d730f011ee400b3fb282d6af8443276dfb9d270",
  modelFamily: "medasr_lasr",
  metadata: {
    vocabPath: "models/medasr_lasr_vocab.json",
    vocabSha256:
      "631bd152b5beca9a74d21bd1c3ff53fecf63d10d11aae72e491cacdfbf69a756",
    lmPath: "models/lm_6.kenlm",
    kenlmWasmPath: "kenlm/kenlm.js",
  },
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const ID_RE = /^[A-Za-z0-9._-]{3,128}$/;

export function validatePluginManifest(
  manifest: PluginManifest,
): PluginValidationIssue[] {
  const issues: PluginValidationIssue[] = [];

  if (!ID_RE.test(manifest.pluginId)) {
    issues.push({
      field: "pluginId",
      message: "pluginId must be 3-128 characters and use [A-Za-z0-9._-]",
    });
  }

  if (!manifest.name.trim()) {
    issues.push({ field: "name", message: "name is required" });
  }

  if (!SEMVER_RE.test(manifest.version)) {
    issues.push({
      field: "version",
      message: "version must follow semver format (x.y.z)",
    });
  }

  if (!manifest.entrypointPath.trim()) {
    issues.push({
      field: "entrypointPath",
      message: "entrypointPath is required",
    });
  }

  if (!SHA256_RE.test(manifest.sha256)) {
    issues.push({
      field: "sha256",
      message: "sha256 must be 64 lowercase hex characters",
    });
  }

  if (manifest.kind === "asr") {
    const vocabPath = manifest.metadata?.vocabPath;
    if (typeof vocabPath !== "string" || !vocabPath.trim()) {
      issues.push({
        field: "metadata.vocabPath",
        message: "asr plugins must include metadata.vocabPath",
      });
    }
  }

  if (manifest.sizeBytes !== undefined && manifest.sizeBytes < 0) {
    issues.push({
      field: "sizeBytes",
      message: "sizeBytes must be zero or greater",
    });
  }

  return issues;
}
