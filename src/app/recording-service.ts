import {
  createRecording,
  createTextAttachment,
  type Attachment,
} from "../domain/recording";
import { createUlid } from "../domain/ulid";
import type { RecordingStore } from "../storage/store";

export interface SaveTranscriptInput {
  recordingId: string;
  attachmentId?: string | null;
  transcript: string;
}

export interface SaveTranscriptResult {
  recordingId: string;
  attachmentId: string;
  transcript: string;
}

export interface LoadedTranscriptResult {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
}

export class RecordingService {
  constructor(private readonly store: RecordingStore) {}

  createDraftRecordingId(): string {
    return createUlid();
  }

  async getLatestRecordingId(): Promise<string | null> {
    const items = await this.store.listRecordings();
    return items[0]?.recordingId ?? null;
  }

  async loadTranscript(
    recordingId: string,
  ): Promise<LoadedTranscriptResult | null> {
    const recording = await this.store.getRecording(recordingId);
    if (!recording) {
      return null;
    }

    const target = this.pickTranscriptAttachment(
      recording.attachments,
      recording.activeAttachmentId,
    );
    if (!target) {
      return {
        recordingId,
        attachmentId: null,
        transcript: "",
      };
    }

    try {
      const transcript = await this.store.readText(target.path);
      return {
        recordingId,
        attachmentId: target.attachmentId,
        transcript,
      };
    } catch {
      return {
        recordingId,
        attachmentId: null,
        transcript: "",
      };
    }
  }

  async saveTranscript(
    input: SaveTranscriptInput,
  ): Promise<SaveTranscriptResult> {
    if (!input.transcript.trim()) {
      throw new Error("transcript is required");
    }

    const now = new Date().toISOString();
    const recording =
      (await this.store.getRecording(input.recordingId)) ??
      createRecording({ createdAt: now, recordingId: input.recordingId });
    const target =
      this.findAttachment(recording.attachments, input.attachmentId) ??
      this.pickTranscriptAttachment(
        recording.attachments,
        recording.activeAttachmentId,
      );
    const attachmentId = target?.attachmentId ?? createUlid();

    const written = await this.store.writeAttachmentText({
      recordingId: input.recordingId,
      attachmentId,
      extension: "txt",
      text: input.transcript,
    });

    if (target) {
      const updatedTarget: Attachment = {
        ...target,
        path: written.path,
        metadata: {
          ...target.metadata,
          sizeBytes: written.sizeBytes,
        },
      };
      recording.attachments = recording.attachments.map((attachment) =>
        attachment.attachmentId === updatedTarget.attachmentId
          ? updatedTarget
          : attachment,
      );
      recording.activeAttachmentId = target.attachmentId;
    } else {
      const attachment = createTextAttachment({
        attachmentId,
        kind: "transcript_raw",
        role: "source",
        createdAt: now,
        createdBy: "asr",
        path: written.path,
        metadata: {
          sizeBytes: written.sizeBytes,
        },
      });
      recording.attachments.push(attachment);
      recording.activeAttachmentId = attachment.attachmentId;
    }
    recording.updatedAt = now;

    await this.store.saveRecording(recording);
    return {
      recordingId: input.recordingId,
      attachmentId,
      transcript: input.transcript,
    };
  }

  private findAttachment(
    attachments: Attachment[],
    attachmentId: string | null | undefined,
  ): Attachment | null {
    if (!attachmentId) {
      return null;
    }
    const target = attachments.find(
      (attachment) => attachment.attachmentId === attachmentId,
    );
    if (!target || target.kind !== "transcript_raw") {
      return null;
    }
    return target;
  }

  private pickTranscriptAttachment(
    attachments: Attachment[],
    activeAttachmentId: string | null = null,
  ): Attachment | null {
    const active = this.findAttachment(attachments, activeAttachmentId);
    if (active) {
      return active;
    }
    const transcriptAttachments = attachments.filter(
      (attachment) => attachment.kind === "transcript_raw",
    );
    if (transcriptAttachments.length === 0) {
      return null;
    }
    transcriptAttachments.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    return transcriptAttachments[0] ?? null;
  }
}
