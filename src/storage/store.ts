import type { Recording, RecordingSummary } from "../domain/recording";

export interface StorageInitResult {
  appDataDir: string;
  removedTempFiles: number;
  skippedInvalidRecordings: number;
  missingAttachments: number;
}

export interface WriteAttachmentTextInput {
  recordingId: string;
  attachmentId: string;
  extension: string;
  text: string;
}

export interface WriteAttachmentTextResult {
  path: string;
  sizeBytes: number;
}

export interface RecordingStore {
  init(): Promise<StorageInitResult>;
  listRecordings(): Promise<RecordingSummary[]>;
  getRecording(recordingId: string): Promise<Recording | null>;
  saveRecording(recording: Recording): Promise<void>;
  readText(path: string): Promise<string>;
  writeAttachmentText(
    input: WriteAttachmentTextInput,
  ): Promise<WriteAttachmentTextResult>;
}
