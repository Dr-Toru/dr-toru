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

  it("saves and loads an llm_artifact", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    await service.saveTranscript({
      recordingId,
      transcript: "Patient reports headache.",
    });

    const result = await service.saveArtifact({
      recordingId,
      artifactType: "soap",
      content: "SUBJECTIVE: Headache\nOBJECTIVE: ...",
      sourceTranscriptId: null,
      sourceContextId: null,
    });

    expect(result.recordingId).toBe(recordingId);
    expect(result.attachmentId).toBeTruthy();

    const artifacts = await service.loadArtifacts(recordingId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.artifactType).toBe("soap");
    expect(artifacts[0]?.content).toBe("SUBJECTIVE: Headache\nOBJECTIVE: ...");
    expect(artifacts[0]?.attachmentId).toBe(result.attachmentId);

    const recording = await store.getRecording(recordingId);
    const att = recording?.attachments.find((a) => a.kind === "llm_artifact");
    expect(att?.role).toBe("derived");
    expect(att?.createdBy).toBe("llm");
    expect(att?.metadata.artifactType).toBe("soap");
  });

  it("deletes an artifact", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    const saved = await service.saveArtifact({
      recordingId,
      artifactType: "progress",
      content: "Progress note content",
      sourceTranscriptId: null,
      sourceContextId: null,
    });

    await service.deleteArtifact({
      recordingId,
      attachmentId: saved.attachmentId,
    });

    const artifacts = await service.loadArtifacts(recordingId);
    expect(artifacts).toHaveLength(0);
  });

  it("supports multiple artifacts per recording", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    await service.saveArtifact({
      recordingId,
      artifactType: "soap",
      content: "SOAP content",
      sourceTranscriptId: null,
      sourceContextId: null,
    });
    await service.saveArtifact({
      recordingId,
      artifactType: "referral",
      content: "Referral content",
      sourceTranscriptId: null,
      sourceContextId: null,
    });

    const artifacts = await service.loadArtifacts(recordingId);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.artifactType).toBe("soap");
    expect(artifacts[1]?.artifactType).toBe("referral");
  });

  it("rejects empty artifact content", async () => {
    const store = new NoopRecordingStore();
    const service = new RecordingService(store);
    const recordingId = service.createDraftRecordingId();

    await expect(
      service.saveArtifact({
        recordingId,
        artifactType: "soap",
        content: "   ",
        sourceTranscriptId: null,
        sourceContextId: null,
      }),
    ).rejects.toThrow("artifact content is required");
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
