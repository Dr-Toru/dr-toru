import {
  NoopPluginRegistryStore,
  type PluginRegistryStore,
  TauriPluginRegistryStore,
  canUseTauriPluginStore,
} from "./store";

let registryStore: PluginRegistryStore | null = null;

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
