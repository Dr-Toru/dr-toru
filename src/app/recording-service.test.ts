import { describe, expect, it } from "vitest";

import { NoopRecordingStore } from "../storage/noop-store";
import { RecordingService } from "./recording-service";

describe("RecordingService", () => {
  it("reuses the same transcript attachment within a recording context", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    const first = await service.saveTranscript({
      recordingId,
      transcript: "Hello world",
    });
    const second = await service.saveTranscript({
      recordingId,
      attachmentId: first.attachmentId,
      transcript: "Hello world\nSecond line",
    });
    const recording = await store.getRecording(recordingId);

    expect(recording).not.toBeNull();
    expect(recording?.recordingId).toBe(recordingId);
    expect(second.recordingId).toBe(recordingId);
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(recording?.activeAttachmentId).toBe(first.attachmentId);
    expect(recording?.attachments).toHaveLength(1);
    expect(recording?.attachments[0]?.attachmentId).toBe(first.attachmentId);
    expect(recording?.attachments[0]?.kind).toBe("transcript_raw");
    expect(recording?.attachments[0]?.role).toBe("source");
    expect(recording?.attachments[0]?.createdBy).toBe("asr");
    expect(recording?.attachments[0]?.metadata).toMatchObject({
      sizeBytes: "Hello world\nSecond line".length,
    });
    expect(recording?.attachments[0]?.path).toContain(
      `recordings/${recordingId}/attachments/`,
    );

    const loaded = await service.loadTranscript(recordingId);
    expect(loaded?.attachmentId).toBe(first.attachmentId);
    expect(loaded?.transcript).toBe("Hello world\nSecond line");
  });

  it("rejects empty transcript input", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    await expect(
      service.saveTranscript({ recordingId, transcript: "   " }),
    ).rejects.toThrow("transcript is required");
  });
});
