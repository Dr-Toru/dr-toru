import {
  canProvideRole,
  type PluginCapability,
  type PluginManifest,
  type ProviderRole,
  validatePluginManifest,
} from "./contracts";
import type {
  DiscoverPluginsRequest,
  PluginImportRequest,
  PluginRegistryStore,
  PluginServiceHealth,
} from "./store";

function isManifestValid(manifest: PluginManifest): boolean {
  return validatePluginManifest(manifest).length === 0;
}

export class PluginService {
  constructor(private readonly store: PluginRegistryStore) {}

  async init(): Promise<void> {
    await this.store.init();
  }

  async listValid(): Promise<PluginManifest[]> {
    const plugins = await this.store.list();
    return plugins.filter(isManifestValid);
  }

  async discover(
    request: DiscoverPluginsRequest = {},
  ): Promise<PluginManifest[]> {
    const plugins = await this.store.discover(request);
    return plugins.filter(isManifestValid);
  }

  async activePlugin(role: ProviderRole): Promise<PluginManifest | null> {
    const [plugins, active] = await Promise.all([
      this.listValid(),
      this.store.getActiveProviders(),
    ]);
    const pluginId = active[role];
    if (!pluginId) {
      return null;
    }
    const plugin = plugins.find((item) => item.pluginId === pluginId);
    if (!plugin) {
      return null;
    }
    if (!canProvideRole(plugin, role)) {
      return null;
    }
    return plugin;
  }

  async setActiveProvider(
    role: ProviderRole,
    pluginId: string | null,
  ): Promise<void> {
    await this.store.setActiveProvider(role, pluginId);
  }

  importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    return this.store.importFromPath(request);
  }

  startService(pluginId: string): Promise<PluginServiceHealth> {
    return this.store.startService(pluginId);
  }

  serviceStatus(pluginId: string): Promise<PluginServiceHealth> {
    return this.store.getServiceStatus(pluginId);
  }

  stopService(pluginId: string): Promise<PluginServiceHealth> {
    return this.store.stopService(pluginId);
  }

  async hasCapability(
    role: ProviderRole,
    capability: PluginCapability,
  ): Promise<boolean> {
    const plugin = await this.activePlugin(role);
    if (!plugin) {
      return false;
    }
    return plugin.capabilities.includes(capability);
  }
}
