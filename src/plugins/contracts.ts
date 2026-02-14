export const PLUGIN_REGISTRY_FORMAT = 1 as const;

export const PLUGIN_KINDS = ["asr", "llm"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_RUNTIMES = ["ort", "llamafile"] as const;
export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number];

export const PROVIDER_ROLES = ["asr", "transform"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export const PLUGIN_CAPABILITIES = [
  "asr.stream",
  "llm.transform.correct",
  "llm.transform.soap",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

type FeatureMatch = "all" | "any";

interface FeatureRequirement {
  role: ProviderRole;
  capabilities: PluginCapability[];
  match: FeatureMatch;
}

export const PLUGIN_FEATURE_REQUIREMENTS = {
  transcription: {
    role: "asr",
    capabilities: ["asr.stream"],
    match: "all",
  },
  transform: {
    role: "transform",
    capabilities: ["llm.transform.correct", "llm.transform.soap"],
    match: "any",
  },
} as const satisfies Record<string, FeatureRequirement>;

export type PluginFeature = keyof typeof PLUGIN_FEATURE_REQUIREMENTS;

export interface PluginManifest {
  pluginId: string;
  name: string;
  version: string;
  kind: PluginKind;
  runtime: PluginRuntime;
  entrypointPath: string;
  sha256: string;
  capabilities: PluginCapability[];
  modelFamily?: string;
  sizeBytes?: number;
  license?: string;
  installedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PluginRegistryState {
  format: typeof PLUGIN_REGISTRY_FORMAT;
  plugins: PluginManifest[];
  activeProviders: Record<ProviderRole, string | null>;
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
  runtime: "ort",
  entrypointPath: "models/medasr_lasr_ctc.onnx",
  sha256: "f1d2ea1680bfa2a8adc76b80403b1edce20a6f1681bde1a20cc42ab59136d971",
  capabilities: ["asr.stream"],
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

export function hasCapability(
  manifest: PluginManifest,
  capability: PluginCapability,
): boolean {
  return manifest.capabilities.includes(capability);
}

export function canProvideRole(
  manifest: PluginManifest,
  role: ProviderRole,
): boolean {
  if (role === "asr") {
    return manifest.kind === "asr" && hasCapability(manifest, "asr.stream");
  }
  return (
    manifest.kind === "llm" &&
    (hasCapability(manifest, "llm.transform.correct") ||
      hasCapability(manifest, "llm.transform.soap"))
  );
}

export function supportsFeature(
  manifest: PluginManifest | null | undefined,
  feature: PluginFeature,
): boolean {
  if (!manifest) {
    return false;
  }

  const requirement = PLUGIN_FEATURE_REQUIREMENTS[feature];
  if (!canProvideRole(manifest, requirement.role)) {
    return false;
  }

  if (requirement.match === "all") {
    return requirement.capabilities.every((capability) =>
      hasCapability(manifest, capability),
    );
  }

  return requirement.capabilities.some((capability) =>
    hasCapability(manifest, capability),
  );
}

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

  if (manifest.capabilities.length === 0) {
    issues.push({
      field: "capabilities",
      message: "at least one capability is required",
    });
  }

  const unique = new Set<PluginCapability>();
  for (const capability of manifest.capabilities) {
    if (!PLUGIN_CAPABILITIES.includes(capability)) {
      issues.push({
        field: "capabilities",
        message: `unsupported capability: ${String(capability)}`,
      });
      continue;
    }
    if (unique.has(capability)) {
      issues.push({
        field: "capabilities",
        message: `duplicate capability: ${capability}`,
      });
      continue;
    }
    unique.add(capability);
  }

  if (manifest.kind === "asr") {
    if (manifest.runtime !== "ort") {
      issues.push({
        field: "runtime",
        message: "asr plugins must use ort runtime in v1",
      });
    }
    if (!hasCapability(manifest, "asr.stream")) {
      issues.push({
        field: "capabilities",
        message: "asr plugins must include asr.stream",
      });
    }
    const vocabPath = manifest.metadata?.vocabPath;
    if (typeof vocabPath !== "string" || !vocabPath.trim()) {
      issues.push({
        field: "metadata.vocabPath",
        message: "asr plugins must include metadata.vocabPath",
      });
    }
  }

  if (manifest.kind === "llm") {
    if (manifest.runtime !== "llamafile") {
      issues.push({
        field: "runtime",
        message: "llm plugins must use llamafile runtime in v1",
      });
    }
    if (
      !hasCapability(manifest, "llm.transform.correct") &&
      !hasCapability(manifest, "llm.transform.soap")
    ) {
      issues.push({
        field: "capabilities",
        message: "llm plugins must include a transform capability",
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
