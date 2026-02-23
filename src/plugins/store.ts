import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  PLUGIN_REGISTRY_FORMAT,
  type PluginKind,
  type PluginManifest,
  type PluginRegistryState,
  validatePluginManifest,
} from "./contracts";

export interface DiscoverPluginsRequest {
  kind?: PluginKind;
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

export interface PluginRegistryStore {
  init(): Promise<PluginRegistryState>;
  list(): Promise<PluginManifest[]>;
  discover(request?: DiscoverPluginsRequest): Promise<PluginManifest[]>;
  importFromPath(request: PluginImportRequest): Promise<PluginManifest>;
  add(manifest: PluginManifest): Promise<void>;
  remove(pluginId: string): Promise<void>;
  getActivePlugins(): Promise<Record<PluginKind, string | null>>;
  setActivePlugin(kind: PluginKind, pluginId: string | null): Promise<void>;
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

  getActivePlugins(): Promise<Record<PluginKind, string | null>> {
    return invoke<Record<PluginKind, string | null>>("plugin_registry_active");
  }

  setActivePlugin(kind: PluginKind, pluginId: string | null): Promise<void> {
    return invoke<void>("plugin_registry_set_active", { kind, pluginId });
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
    plugins: [],
    activePlugins: {
      asr: null,
      llm: null,
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
    return this.state.plugins
      .filter((plugin) => (request.kind ? plugin.kind === request.kind : true))
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
    if (this.state.activePlugins[manifest.kind] === null) {
      this.state.activePlugins[manifest.kind] = manifest.pluginId;
    }
  }

  async importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    const sourcePath = request.sourcePath.trim();
    if (!sourcePath) {
      throw new Error("sourcePath is required");
    }

    const fileName = sourcePath.split(/[\\/]/).pop() ?? "";
    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    if (extension !== "llamafile" && extension !== "zip") {
      throw new Error("Only .llamafile and .zip imports are supported");
    }
    if (extension === "zip") {
      throw new Error(
        "Zip package import is only available in desktop runtime",
      );
    }

    const isLlm = extension === "llamafile";
    const baseName =
      request.displayName?.trim() ||
      fileName.replace(/\.(llamafile|zip)$/i, "") ||
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
      runtime: isLlm ? "llamafile" : "ort-ctc",
      entrypointPath: sourcePath,
      hash: "0".repeat(64),
      installedAt: new Date().toISOString(),
      metadata: isLlm ? undefined : {},
    };

    await this.add(manifest);
    return manifest;
  }

  async remove(pluginId: string): Promise<void> {
    this.state.plugins = this.state.plugins.filter(
      (plugin) => plugin.pluginId !== pluginId,
    );
    if (this.state.activePlugins.asr === pluginId) {
      this.state.activePlugins.asr = null;
    }
    if (this.state.activePlugins.llm === pluginId) {
      this.state.activePlugins.llm = null;
    }
  }

  async getActivePlugins(): Promise<Record<PluginKind, string | null>> {
    return { ...this.state.activePlugins };
  }

  async setActivePlugin(
    kind: PluginKind,
    pluginId: string | null,
  ): Promise<void> {
    if (pluginId === null) {
      this.state.activePlugins[kind] = null;
      return;
    }

    const plugin = this.state.plugins.find(
      (item) => item.pluginId === pluginId,
    );
    if (!plugin) {
      throw new Error(`Unknown pluginId: ${pluginId}`);
    }
    if (plugin.kind !== kind) {
      throw new Error(`Plugin ${pluginId} is not of kind ${kind}`);
    }
    this.state.activePlugins[kind] = pluginId;
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
