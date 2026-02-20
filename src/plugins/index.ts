import {
  NoopPluginRegistryStore,
  type PluginRegistryStore,
  TauriPluginRegistryStore,
  canUseTauriPluginStore,
} from "./store";
import { PluginPlatform, type PluginPlatformOptions } from "./platform";

let registryStore: PluginRegistryStore | null = null;
let pluginPlatform: PluginPlatform | null = null;

export function getPluginRegistryStore(): PluginRegistryStore {
  if (registryStore) {
    return registryStore;
  }

  if (canUseTauriPluginStore()) {
    registryStore = new TauriPluginRegistryStore();
    return registryStore;
  }

  registryStore = new NoopPluginRegistryStore();
  return registryStore;
}

export function createPluginPlatform(
  options: PluginPlatformOptions,
): PluginPlatform {
  if (pluginPlatform) {
    return pluginPlatform;
  }
  pluginPlatform = new PluginPlatform(getPluginRegistryStore(), options);
  return pluginPlatform;
}

export { PluginPlatform };
export type {
  PluginPlatformOptions,
  PluginPlatformState,
  CapabilityLoadState,
} from "./platform";
