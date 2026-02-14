import { describe, expect, it } from "vitest";

import { NoopRecordingStore } from "../storage/noop-store";
import { RecordingService } from "./recording-service";

describe("RecordingService", () => {
  it("persists transcript text as source attachment in a new recording", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);

    const result = await service.persistTranscript("Hello world");
    const recording = await store.getRecording(result.recordingId);

    expect(recording).not.toBeNull();
    expect(recording?.recordingId).toBe(result.recordingId);
    expect(recording?.activeAttachmentId).toBe(result.attachmentId);
    expect(recording?.attachments).toHaveLength(1);
    expect(recording?.attachments[0]?.attachmentId).toBe(result.attachmentId);
    expect(recording?.attachments[0]?.kind).toBe("transcript_raw");
    expect(recording?.attachments[0]?.role).toBe("source");
    expect(recording?.attachments[0]?.createdBy).toBe("asr");
    expect(recording?.attachments[0]?.metadata).toMatchObject({ sizeBytes: 11 });
    expect(recording?.attachments[0]?.path).toContain(
      `recordings/${result.recordingId}/attachments/`,
    );
  });

  it("rejects empty transcript input", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);

    await expect(service.persistTranscript("   ")).rejects.toThrow(
      "transcript is required",
    );
  });
});
