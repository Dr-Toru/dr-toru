import { NoopRecordingStore } from "./noop-store";
import type { RecordingStore } from "./store";
import { canUseTauriStore, TauriRecordingStore } from "./tauri-store";

let store: RecordingStore | null = null;

export function getRecordingStore(): RecordingStore {
  if (store) {
    return store;
  }

  if (canUseTauriStore()) {
    store = new TauriRecordingStore();
    return store;
  }

  if (import.meta.env.DEV) {
    store = new NoopRecordingStore();
    return store;
  }

  throw new Error("Tauri runtime not available");
}
