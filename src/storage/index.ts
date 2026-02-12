import { NoopSessionStore } from "./noop-store";
import type { SessionStore } from "./store";
import { canUseTauriStore, TauriSessionStore } from "./tauri-store";

let store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (store) {
    return store;
  }

  if (canUseTauriStore()) {
    store = new TauriSessionStore();
    return store;
  }

  if (import.meta.env.DEV) {
    store = new NoopSessionStore();
    return store;
  }

  throw new Error("Tauri runtime not available");
}
