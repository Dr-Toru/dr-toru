import { describe, expect, it } from "vitest";

import { NoopSessionStore } from "../storage/noop-store";
import { SessionBundleService } from "./session-bundles";

describe("SessionBundleService", () => {
  it("persists transcript text as source artifact in a new session", async () => {
    const store = new NoopSessionStore();
    const service = new SessionBundleService(store);

    const result = await service.saveTranscriptSession("Hello world");
    const session = await store.getSession(result.sessionId);

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe(result.sessionId);
    expect(session?.activeArtifactId).toBe(result.artifactId);
    expect(session?.artifacts).toHaveLength(1);
    expect(session?.artifacts[0]?.artifactId).toBe(result.artifactId);
    expect(session?.artifacts[0]?.kind).toBe("transcript_raw");
    expect(session?.artifacts[0]?.role).toBe("source");
    expect(session?.artifacts[0]?.createdBy).toBe("asr");
    expect(session?.artifacts[0]?.path).toContain(
      `sessions/${result.sessionId}/artifacts/`,
    );
  });

  it("rejects empty transcript input", async () => {
    const store = new NoopSessionStore();
    const service = new SessionBundleService(store);

    await expect(service.saveTranscriptSession("   ")).rejects.toThrow(
      "transcript is required",
    );
  });
});
