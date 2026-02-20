import { invoke, isTauri } from "@tauri-apps/api/core";

import type { Recording, RecordingSummary } from "../domain/recording";
import type {
  RecordingStore,
  StorageInitResult,
  WriteAttachmentTextInput,
  WriteAttachmentTextResult,
} from "./store";

export function canUseTauriStore(): boolean {
  return isTauri();
}

export class TauriRecordingStore implements RecordingStore {
  init(): Promise<StorageInitResult> {
    return invoke<StorageInitResult>("storage_init");
  }

  listRecordings(): Promise<RecordingSummary[]> {
    return invoke<RecordingSummary[]>("storage_list_recordings");
  }

  getRecording(recordingId: string): Promise<Recording | null> {
    return invoke<Recording | null>("storage_get_recording", { recordingId });
  }

  saveRecording(recording: Recording): Promise<void> {
    return invoke<void>("storage_save_recording", { recording });
  }

  deleteRecording(recordingId: string): Promise<void> {
    return invoke<void>("storage_delete_recording", { recordingId });
  }

  canExportRecordings(): boolean {
    return true;
  }

  exportRecording(recordingId: string, destinationPath: string): Promise<void> {
    return invoke<void>("storage_export_recording", {
      recordingId,
      destinationPath,
    });
  }

  readText(path: string): Promise<string> {
    return invoke<string>("storage_read_text", { path });
  }

  writeAttachmentText(
    input: WriteAttachmentTextInput,
  ): Promise<WriteAttachmentTextResult> {
    return invoke<WriteAttachmentTextResult>("storage_write_attachment_text", {
      request: input,
    });
  }
}
