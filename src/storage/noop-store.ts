import type { Recording, RecordingSummary } from "../domain/recording";
import type {
  RecordingStore,
  StorageInitResult,
  WriteAttachmentTextInput,
  WriteAttachmentTextResult,
} from "./store";

const EMPTY_INIT_RESULT: StorageInitResult = {
  appDataDir: "",
  removedTempFiles: 0,
  skippedInvalidRecordings: 0,
  missingAttachments: 0,
};

export class NoopRecordingStore implements RecordingStore {
  private readonly recordings = new Map<string, Recording>();
  private readonly textByPath = new Map<string, string>();

  async init(): Promise<StorageInitResult> {
    return EMPTY_INIT_RESULT;
  }

  async listRecordings(): Promise<RecordingSummary[]> {
    const items: RecordingSummary[] = [];
    for (const recording of this.recordings.values()) {
      items.push({
        recordingId: recording.recordingId,
        createdAt: recording.createdAt,
        updatedAt: recording.updatedAt,
        activeAttachmentId: recording.activeAttachmentId,
        attachmentCount: recording.attachments.length,
      });
    }
    return items.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async getRecording(recordingId: string): Promise<Recording | null> {
    return this.recordings.get(recordingId) ?? null;
  }

  async saveRecording(recording: Recording): Promise<void> {
    this.recordings.set(recording.recordingId, recording);
  }

  async readText(path: string): Promise<string> {
    const text = this.textByPath.get(path);
    if (text === undefined) {
      throw new Error(`text not found: ${path}`);
    }
    return text;
  }

  async writeAttachmentText(
    input: WriteAttachmentTextInput,
  ): Promise<WriteAttachmentTextResult> {
    const path = `recordings/${input.recordingId}/attachments/${input.attachmentId}.${input.extension}`;
    this.textByPath.set(path, input.text);
    return {
      path,
      sizeBytes: input.text.length,
    };
  }
}
