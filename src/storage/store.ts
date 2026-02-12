import type { SessionRecord, SessionSummary } from "../domain/session";

export interface StorageInitResult {
  appDataDir: string;
  removedTempFiles: number;
  skippedInvalidSessions: number;
  missingArtifacts: number;
}

export interface WriteArtifactTextInput {
  sessionId: string;
  artifactId: string;
  extension: string;
  text: string;
}

export interface WriteArtifactTextResult {
  path: string;
  sizeBytes: number;
}

export interface SessionStore {
  init(): Promise<StorageInitResult>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  writeArtifactText(input: WriteArtifactTextInput): Promise<WriteArtifactTextResult>;
}
