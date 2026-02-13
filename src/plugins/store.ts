import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  BUILTIN_ORT_ASR_PLUGIN,
  PLUGIN_REGISTRY_FORMAT,
  canProvideRole,
  type PluginCapability,
  type PluginManifest,
  type PluginRegistryState,
  type ProviderRole,
  validatePluginManifest,
} from "./contracts";

export interface DiscoverPluginsRequest {
  role?: ProviderRole;
  requiredCapabilities?: PluginCapability[];
}

export interface PluginImportRequest {
  sourcePath: string;
  displayName?: string;
}

export interface PluginServiceHealth {
  ready: boolean;
  running: boolean;
  message: string;
  pid: number | null;
  endpoint: string | null;
}

function deriveOnnxVocabPath(sourcePath: string): string {
  const fileName = sourcePath.split(/[\\/]/).pop() ?? "";
  const baseName = fileName.replace(/\.onnx$/i, "");
  const separator = sourcePath.includes("\\") ? "\\" : "/";
  const index = Math.max(
    sourcePath.lastIndexOf("/"),
    sourcePath.lastIndexOf("\\"),
  );
  const dir = index >= 0 ? sourcePath.slice(0, index) : "";
  const vocabName = `${baseName}_vocab.json`;
  return dir ? `${dir}${separator}${vocabName}` : vocabName;
}

export interface PluginRegistryStore {
  init(): Promise<PluginRegistryState>;
  list(): Promise<PluginManifest[]>;
  discover(request?: DiscoverPluginsRequest): Promise<PluginManifest[]>;
  importFromPath(request: PluginImportRequest): Promise<PluginManifest>;
  add(manifest: PluginManifest): Promise<void>;
  remove(pluginId: string): Promise<void>;
  getActiveProviders(): Promise<Record<ProviderRole, string | null>>;
  setActiveProvider(role: ProviderRole, pluginId: string | null): Promise<void>;
  startService(pluginId: string): Promise<PluginServiceHealth>;
  getServiceStatus(pluginId: string): Promise<PluginServiceHealth>;
  stopService(pluginId: string): Promise<PluginServiceHealth>;
}

export function canUseTauriPluginStore(): boolean {
  return isTauri();
}

export class TauriPluginRegistryStore implements PluginRegistryStore {
  init(): Promise<PluginRegistryState> {
    return invoke<PluginRegistryState>("plugin_registry_init");
  }

  list(): Promise<PluginManifest[]> {
    return invoke<PluginManifest[]>("plugin_registry_list");
  }

  discover(request: DiscoverPluginsRequest = {}): Promise<PluginManifest[]> {
    return invoke<PluginManifest[]>("plugin_registry_discover", { request });
  }

  importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    return invoke<PluginManifest>("plugin_import_from_path", { request });
  }

  add(manifest: PluginManifest): Promise<void> {
    return invoke<void>("plugin_registry_add", { manifest });
  }

  remove(pluginId: string): Promise<void> {
    return invoke<void>("plugin_registry_remove", { pluginId });
  }

  getActiveProviders(): Promise<Record<ProviderRole, string | null>> {
    return invoke<Record<ProviderRole, string | null>>(
      "plugin_registry_active",
    );
  }

  setActiveProvider(
    role: ProviderRole,
    pluginId: string | null,
  ): Promise<void> {
    return invoke<void>("plugin_registry_set_active", { role, pluginId });
  }

  startService(pluginId: string): Promise<PluginServiceHealth> {
    return invoke<PluginServiceHealth>("plugin_service_start", { pluginId });
  }

  getServiceStatus(pluginId: string): Promise<PluginServiceHealth> {
    return invoke<PluginServiceHealth>("plugin_service_status", { pluginId });
  }

  stopService(pluginId: string): Promise<PluginServiceHealth> {
    return invoke<PluginServiceHealth>("plugin_service_stop", { pluginId });
  }
}

export class NoopPluginRegistryStore implements PluginRegistryStore {
  private state: PluginRegistryState = {
    format: PLUGIN_REGISTRY_FORMAT,
    plugins: [{ ...BUILTIN_ORT_ASR_PLUGIN }],
    activeProviders: {
      asr: BUILTIN_ORT_ASR_PLUGIN.pluginId,
      transform: null,
    },
  };

  async init(): Promise<PluginRegistryState> {
    return structuredClone(this.state);
  }

  async list(): Promise<PluginManifest[]> {
    return this.state.plugins.map((plugin) => ({ ...plugin }));
  }

  async discover(
    request: DiscoverPluginsRequest = {},
  ): Promise<PluginManifest[]> {
    const required = request.requiredCapabilities ?? [];
    return this.state.plugins
      .filter((plugin) =>
        request.role ? canProvideRole(plugin, request.role) : true,
      )
      .filter((plugin) =>
        required.every((capability) =>
          plugin.capabilities.includes(capability),
        ),
      )
      .map((plugin) => ({ ...plugin }));
  }

  async add(manifest: PluginManifest): Promise<void> {
    const issues = validatePluginManifest(manifest);
    if (issues.length > 0) {
      throw new Error(
        issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
      );
    }
    if (
      this.state.plugins.some((plugin) => plugin.pluginId === manifest.pluginId)
    ) {
      throw new Error(`Plugin already exists: ${manifest.pluginId}`);
    }
    this.state.plugins.push({ ...manifest });
    if (
      this.state.activeProviders.asr === null &&
      canProvideRole(manifest, "asr")
    ) {
      this.state.activeProviders.asr = manifest.pluginId;
    }
    if (
      this.state.activeProviders.transform === null &&
      canProvideRole(manifest, "transform")
    ) {
      this.state.activeProviders.transform = manifest.pluginId;
    }
  }

  async importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    const sourcePath = request.sourcePath.trim();
    if (!sourcePath) {
      throw new Error("sourcePath is required");
    }

    const fileName = sourcePath.split(/[\\/]/).pop() ?? "";
    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    if (
      extension !== "llamafile" &&
      extension !== "onnx" &&
      extension !== "asrpkg"
    ) {
      throw new Error(
        "Only .llamafile, .onnx, and .asrpkg imports are supported",
      );
    }
    if (extension === "asrpkg") {
      throw new Error(
        "ASR package import is only available in desktop runtime",
      );
    }

    const isLlm = extension === "llamafile";
    const baseName =
      request.displayName?.trim() ||
      fileName.replace(/\.(llamafile|onnx)$/i, "") ||
      "Imported Model";
    const timestamp = Date.now();
    const normalizedSlug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const slug = normalizedSlug.replace(/^-+|-+$/g, "") || "model";
    const pluginId = `${isLlm ? "import.llm" : "import.asr"}.${slug}.${timestamp}`;
    const manifest: PluginManifest = {
      pluginId,
      name: baseName,
      version: "1.0.0",
      kind: isLlm ? "llm" : "asr",
      runtime: isLlm ? "llamafile" : "ort",
      entrypointPath: sourcePath,
      sha256: "0".repeat(64),
      capabilities: isLlm
        ? ["llm.transform.correct", "llm.transform.soap"]
        : ["asr.stream"],
      installedAt: new Date().toISOString(),
      metadata: isLlm
        ? undefined
        : {
            vocabPath: deriveOnnxVocabPath(sourcePath),
            vocabSha256: "0".repeat(64),
          },
    };

    await this.add(manifest);
    return manifest;
  }

  async remove(pluginId: string): Promise<void> {
    if (pluginId === BUILTIN_ORT_ASR_PLUGIN.pluginId) {
      throw new Error("Built-in ASR plugin cannot be removed");
    }

    this.state.plugins = this.state.plugins.filter(
      (plugin) => plugin.pluginId !== pluginId,
    );
    if (this.state.activeProviders.asr === pluginId) {
      this.state.activeProviders.asr = null;
    }
    if (this.state.activeProviders.transform === pluginId) {
      this.state.activeProviders.transform = null;
    }
  }

  async getActiveProviders(): Promise<Record<ProviderRole, string | null>> {
    return { ...this.state.activeProviders };
  }

  async setActiveProvider(
    role: ProviderRole,
    pluginId: string | null,
  ): Promise<void> {
    if (pluginId === null) {
      this.state.activeProviders[role] = null;
      return;
    }

    const plugin = this.state.plugins.find(
      (item) => item.pluginId === pluginId,
    );
    if (!plugin) {
      throw new Error(`Unknown pluginId: ${pluginId}`);
    }
    if (!canProvideRole(plugin, role)) {
      throw new Error(`Plugin ${pluginId} cannot be active for role ${role}`);
    }
    this.state.activeProviders[role] = pluginId;
  }

  async startService(pluginId: string): Promise<PluginServiceHealth> {
    return {
      ready: false,
      running: false,
      message: `Service unavailable in noop store for ${pluginId}`,
      pid: null,
      endpoint: null,
    };
  }

  async getServiceStatus(pluginId: string): Promise<PluginServiceHealth> {
    return {
      ready: false,
      running: false,
      message: `Service unavailable in noop store for ${pluginId}`,
      pid: null,
      endpoint: null,
    };
  }

  async stopService(pluginId: string): Promise<PluginServiceHealth> {
    return {
      ready: false,
      running: false,
      message: `Service stopped for ${pluginId}`,
      pid: null,
      endpoint: null,
    };
  }
}
