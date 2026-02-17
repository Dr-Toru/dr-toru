import { createUlid } from "./ulid";

export const RECORDING_FORMAT = 1 as const;

export type AttachmentRole = "source" | "derived";
export type AttachmentCreator = "asr" | "llm" | "user" | "system";
export type AttachmentMetaValue = string | number | boolean | null;
export type AttachmentKind =
  | "transcript_raw"
  | "transcript_corrected"
  | "audio_capture"
  | "context_note"
  | "llm_artifact";
export type TextAttachmentKind = Extract<
  AttachmentKind,
  "transcript_raw" | "transcript_corrected" | "context_note" | "llm_artifact"
>;

export interface Attachment {
  attachmentId: string;
  kind: AttachmentKind;
  role: AttachmentRole;
  contentType: string;
  path: string;
  createdAt: string;
  createdBy: AttachmentCreator;
  sourceAttachmentId: string | null;
  metadata: Record<string, AttachmentMetaValue>;
}

export interface Recording {
  format: typeof RECORDING_FORMAT;
  recordingId: string;
  createdAt: string;
  updatedAt: string;
  activeAttachmentId: string | null;
  attachments: Attachment[];
}

export interface RecordingSummary {
  recordingId: string;
  createdAt: string;
  updatedAt: string;
  activeAttachmentId: string | null;
  attachmentCount: number;
}

export interface NewRecordingInput {
  recordingId?: string;
  createdAt?: string;
}

export interface NewTextAttachmentInput {
  attachmentId?: string;
  kind: TextAttachmentKind;
  role: AttachmentRole;
  createdAt?: string;
  createdBy: AttachmentCreator;
  path: string;
  sourceAttachmentId?: string | null;
  metadata?: Record<string, AttachmentMetaValue>;
}

export function createRecording(input: NewRecordingInput = {}): Recording {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    format: RECORDING_FORMAT,
    recordingId: input.recordingId ?? createUlid(),
    createdAt,
    updatedAt: createdAt,
    activeAttachmentId: null,
    attachments: [],
  };
}

export function createTextAttachment(
  input: NewTextAttachmentInput,
): Attachment {
  return {
    attachmentId: input.attachmentId ?? createUlid(),
    kind: input.kind,
    role: input.role,
    contentType: "text/plain",
    path: input.path,
    createdAt: input.createdAt ?? new Date().toISOString(),
    createdBy: input.createdBy,
    sourceAttachmentId: input.sourceAttachmentId ?? null,
    metadata: input.metadata ?? {},
  };
}
