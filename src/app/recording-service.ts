import { createRecording, createTextAttachment } from "../domain/recording";
import { createUlid } from "../domain/ulid";
import type { RecordingStore } from "../storage/store";

export interface SaveTranscriptResult {
  recordingId: string;
  attachmentId: string;
}

export class RecordingService {
  constructor(private readonly store: RecordingStore) {}

  async persistTranscript(transcript: string): Promise<SaveTranscriptResult> {
    const text = transcript.trim();
    if (!text) {
      throw new Error("transcript is required");
    }

    const createdAt = new Date().toISOString();
    const recording = createRecording({ createdAt });
    const attachmentId = createUlid();

    const written = await this.store.writeAttachmentText({
      recordingId: recording.recordingId,
      attachmentId,
      extension: "txt",
      text,
    });

    const attachment = createTextAttachment({
      attachmentId,
      kind: "transcript_raw",
      role: "source",
      createdAt,
      createdBy: "asr",
      path: written.path,
      metadata: {
        sizeBytes: written.sizeBytes,
      },
    });

    recording.attachments.push(attachment);
    recording.activeAttachmentId = attachment.attachmentId;
    recording.updatedAt = createdAt;

    await this.store.saveRecording(recording);
    return {
      recordingId: recording.recordingId,
      attachmentId,
    };
  }
}
