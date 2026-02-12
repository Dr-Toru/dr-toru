import type { SessionRecord, SessionSummary } from "../domain/session";
import type {
  SessionStore,
  StorageInitResult,
  WriteArtifactTextInput,
  WriteArtifactTextResult,
} from "./store";

const EMPTY_INIT_RESULT: StorageInitResult = {
  appDataDir: "",
  removedTempFiles: 0,
  skippedInvalidSessions: 0,
  missingArtifacts: 0,
};

export class NoopSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async init(): Promise<StorageInitResult> {
    return EMPTY_INIT_RESULT;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const items: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      items.push({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        activeArtifactId: session.activeArtifactId,
        artifactCount: session.artifacts.length,
      });
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async writeArtifactText(input: WriteArtifactTextInput): Promise<WriteArtifactTextResult> {
    return {
      path: `sessions/${input.sessionId}/artifacts/${input.artifactId}.${input.extension}`,
      sizeBytes: input.text.length,
    };
  }
}
