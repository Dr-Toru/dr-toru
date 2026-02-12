import { invoke, isTauri } from "@tauri-apps/api/core";

import type { SessionRecord, SessionSummary } from "../domain/session";
import type {
  SessionStore,
  StorageInitResult,
  WriteArtifactTextInput,
  WriteArtifactTextResult,
} from "./store";

export function canUseTauriStore(): boolean {
  return isTauri();
}

export class TauriSessionStore implements SessionStore {
  init(): Promise<StorageInitResult> {
    return invoke<StorageInitResult>("storage_init");
  }

  listSessions(): Promise<SessionSummary[]> {
    return invoke<SessionSummary[]>("storage_list_sessions");
  }

  getSession(sessionId: string): Promise<SessionRecord | null> {
    return invoke<SessionRecord | null>("storage_get_session", { sessionId });
  }

  saveSession(session: SessionRecord): Promise<void> {
    return invoke<void>("storage_save_session", { session });
  }

  writeArtifactText(input: WriteArtifactTextInput): Promise<WriteArtifactTextResult> {
    return invoke<WriteArtifactTextResult>("storage_write_artifact_text", { request: input });
  }
}
