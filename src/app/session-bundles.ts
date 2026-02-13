import { createSession, createTextArtifact } from "../domain/session";
import { createUlid } from "../domain/ulid";
import type { SessionStore } from "../storage/store";

export interface SaveTranscriptSessionResult {
  sessionId: string;
  artifactId: string;
}

export class SessionBundleService {
  constructor(private readonly store: SessionStore) {}

  async saveTranscriptSession(
    transcript: string,
  ): Promise<SaveTranscriptSessionResult> {
    const text = transcript.trim();
    if (!text) {
      throw new Error("transcript is required");
    }

    const createdAt = new Date().toISOString();
    const session = createSession({ createdAt });
    const artifactId = createUlid();

    const written = await this.store.writeArtifactText({
      sessionId: session.sessionId,
      artifactId,
      extension: "txt",
      text,
    });

    const artifact = createTextArtifact({
      artifactId,
      kind: "transcript_raw",
      role: "source",
      createdAt,
      createdBy: "asr",
      path: written.path,
      metadata: {
        sizeBytes: written.sizeBytes,
      },
    });

    session.artifacts.push(artifact);
    session.activeArtifactId = artifact.artifactId;
    session.updatedAt = createdAt;

    await this.store.saveSession(session);
    return {
      sessionId: session.sessionId,
      artifactId,
    };
  }
}
