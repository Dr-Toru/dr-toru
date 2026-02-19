import {
  createRecording,
  createTextAttachment,
  type Attachment,
  type AttachmentCreator,
  type TextAttachmentKind,
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

export interface SaveContextInput {
  recordingId: string;
  attachmentId?: string | null;
  context: string;
}

export interface SaveContextResult {
  recordingId: string;
  attachmentId: string;
  context: string;
}

export interface LoadedContextResult {
  recordingId: string;
  attachmentId: string | null;
  context: string;
}

export class RecordingService {
  constructor(private readonly store: RecordingStore) {}

  createDraftRecordingId(): string {
    return createUlid();
  }

  async loadTranscript(
    recordingId: string,
  ): Promise<LoadedTranscriptResult | null> {
    const result = await this.loadAttachmentText(recordingId, "transcript_raw");
    if (!result) return null;
    return {
      recordingId,
      attachmentId: result.attachmentId,
      transcript: result.text,
    };
  }

  async saveTranscript(
    input: SaveTranscriptInput,
  ): Promise<SaveTranscriptResult> {
    if (!input.transcript.trim()) {
      throw new Error("transcript is required");
    }

    const result = await this.saveAttachmentText({
      recordingId: input.recordingId,
      attachmentId: input.attachmentId,
      kind: "transcript_raw",
      createdBy: "asr",
      text: input.transcript,
      setActive: true,
    });
    return {
      recordingId: input.recordingId,
      attachmentId: result.attachmentId,
      transcript: input.transcript,
    };
  }

  async loadContext(recordingId: string): Promise<LoadedContextResult | null> {
    const result = await this.loadAttachmentText(recordingId, "context_note");
    if (!result) return null;
    return {
      recordingId,
      attachmentId: result.attachmentId,
      context: result.text,
    };
  }

  async saveContext(input: SaveContextInput): Promise<SaveContextResult> {
    const result = await this.saveAttachmentText({
      recordingId: input.recordingId,
      attachmentId: input.attachmentId,
      kind: "context_note",
      createdBy: "user",
      text: input.context,
      setActive: false,
    });
    return {
      recordingId: input.recordingId,
      attachmentId: result.attachmentId,
      context: input.context,
    };
  }

  // -- shared helpers --

  private async loadAttachmentText(
    recordingId: string,
    kind: TextAttachmentKind,
  ): Promise<{ attachmentId: string | null; text: string } | null> {
    const recording = await this.store.getRecording(recordingId);
    if (!recording) return null;

    const preferredId =
      kind === "transcript_raw" ? recording.activeAttachmentId : null;
    const target = pickByKind(recording.attachments, kind, preferredId);
    if (!target) {
      return { attachmentId: null, text: "" };
    }

    try {
      const text = await this.store.readText(target.path);
      return { attachmentId: target.attachmentId, text };
    } catch {
      return { attachmentId: null, text: "" };
    }
  }

  private async saveAttachmentText(opts: {
    recordingId: string;
    attachmentId?: string | null;
    kind: TextAttachmentKind;
    createdBy: AttachmentCreator;
    text: string;
    setActive: boolean;
  }): Promise<{ attachmentId: string }> {
    const now = new Date().toISOString();
    const recording =
      (await this.store.getRecording(opts.recordingId)) ??
      createRecording({ createdAt: now, recordingId: opts.recordingId });

    const existing =
      findByKind(recording.attachments, opts.kind, opts.attachmentId) ??
      pickByKind(
        recording.attachments,
        opts.kind,
        opts.setActive ? recording.activeAttachmentId : null,
      );
    const attachmentId = existing?.attachmentId ?? createUlid();

    const written = await this.store.writeAttachmentText({
      recordingId: opts.recordingId,
      attachmentId,
      extension: "txt",
      text: opts.text,
    });

    if (existing) {
      const updated: Attachment = {
        ...existing,
        path: written.path,
        metadata: { ...existing.metadata, sizeBytes: written.sizeBytes },
      };
      recording.attachments = recording.attachments.map((a) =>
        a.attachmentId === updated.attachmentId ? updated : a,
      );
    } else {
      recording.attachments.push(
        createTextAttachment({
          attachmentId,
          kind: opts.kind,
          role: "source",
          createdAt: now,
          createdBy: opts.createdBy,
          path: written.path,
          metadata: { sizeBytes: written.sizeBytes },
        }),
      );
    }

    if (opts.setActive) {
      recording.activeAttachmentId = attachmentId;
    }
    recording.updatedAt = now;

    await this.store.saveRecording(recording);
    return { attachmentId };
  }
}

function findByKind(
  attachments: Attachment[],
  kind: TextAttachmentKind,
  attachmentId: string | null | undefined,
): Attachment | null {
  if (!attachmentId) return null;
  const target = attachments.find((a) => a.attachmentId === attachmentId);
  if (!target || target.kind !== kind) return null;
  return target;
}

function pickByKind(
  attachments: Attachment[],
  kind: TextAttachmentKind,
  preferredId: string | null | undefined,
): Attachment | null {
  const preferred = findByKind(attachments, kind, preferredId);
  if (preferred) return preferred;

  const matches = attachments.filter((a) => a.kind === kind);
  if (matches.length === 0) return null;

  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0] ?? null;
}
