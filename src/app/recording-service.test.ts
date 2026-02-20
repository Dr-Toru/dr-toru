import { describe, expect, it } from "vitest";

import { createRecording, createTextAttachment } from "../domain/recording";
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
    expect(recording?.searchText).toBe("hello world second line");

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

  it("indexes latest text across text kinds with exact dedup", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();
    const createdAt = new Date().toISOString();
    const recording = createRecording({ recordingId, createdAt });

    const raw = await store.writeAttachmentText({
      recordingId,
      attachmentId: "att-raw",
      extension: "txt",
      text: "Shared plan",
    });
    const corrected = await store.writeAttachmentText({
      recordingId,
      attachmentId: "att-corrected",
      extension: "txt",
      text: "shared   plan",
    });
    const context = await store.writeAttachmentText({
      recordingId,
      attachmentId: "att-context",
      extension: "txt",
      text: "Add family history",
    });

    recording.attachments.push(
      createTextAttachment({
        attachmentId: "att-raw",
        kind: "transcript_raw",
        role: "source",
        createdAt,
        createdBy: "asr",
        path: raw.path,
        metadata: {},
      }),
      createTextAttachment({
        attachmentId: "att-corrected",
        kind: "transcript_corrected",
        role: "derived",
        createdAt,
        createdBy: "llm",
        path: corrected.path,
        metadata: {},
      }),
      createTextAttachment({
        attachmentId: "att-context",
        kind: "context_note",
        role: "source",
        createdAt,
        createdBy: "user",
        path: context.path,
        metadata: {},
      }),
    );
    recording.activeAttachmentId = "att-raw";
    await store.saveRecording(recording);

    await service.saveContext({
      recordingId,
      attachmentId: "att-context",
      context: "Add family history",
    });
    const first = await store.getRecording(recordingId);
    expect(first?.searchText).toBe("shared plan add family history");

    await service.saveContext({
      recordingId,
      attachmentId: "att-context",
      context: "Updated context only",
    });
    const second = await store.getRecording(recordingId);
    expect(second?.searchText).toBe("shared plan updated context only");
  });

  it("drops attachment binding when transcript read fails", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();
    const createdAt = new Date().toISOString();
    const recording = createRecording({ recordingId, createdAt });
    const attachment = createTextAttachment({
      attachmentId: "att-read-fail",
      kind: "transcript_raw",
      role: "source",
      createdAt,
      createdBy: "asr",
      path: `recordings/${recordingId}/attachments/missing.txt`,
      metadata: {},
    });
    recording.attachments.push(attachment);
    recording.activeAttachmentId = attachment.attachmentId;
    await store.saveRecording(recording);

    const loaded = await service.loadTranscript(recordingId);
    expect(loaded).not.toBeNull();
    expect(loaded?.attachmentId).toBeNull();
    expect(loaded?.transcript).toBe("");
  });
});
