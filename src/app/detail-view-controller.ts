import type { RecordingService } from "./recording-service";
import { findTemplate } from "./artifact-prompts";

export interface DetailViewControllerOptions {
  contentEl: HTMLElement;
  typeEl: HTMLElement;
  dateEl: HTMLElement;
  copyBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  recordingService: RecordingService;
  onDeleted: (recordingId: string) => void;
  onError: (error: unknown, context: string) => void;
}

export class DetailViewController {
  private readonly contentEl: HTMLElement;
  private readonly typeEl: HTMLElement;
  private readonly dateEl: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly deleteBtn: HTMLButtonElement;
  private readonly recordingService: RecordingService;
  private readonly onDeleted: (recordingId: string) => void;
  private readonly onError: (error: unknown, context: string) => void;
  private currentContent = "";
  private currentRecordingId = "";
  private currentAttachmentId = "";

  constructor(options: DetailViewControllerOptions) {
    this.contentEl = options.contentEl;
    this.typeEl = options.typeEl;
    this.dateEl = options.dateEl;
    this.copyBtn = options.copyBtn;
    this.deleteBtn = options.deleteBtn;
    this.recordingService = options.recordingService;
    this.onDeleted = options.onDeleted;
    this.onError = options.onError;

    this.copyBtn.addEventListener("click", () => {
      void this.copyToClipboard();
    });
    this.deleteBtn.addEventListener("click", () => {
      void this.deleteArtifact();
    });
  }

  async openRoute(recordingId: string, attachmentId: string): Promise<boolean> {
    this.currentRecordingId = recordingId;
    this.currentAttachmentId = attachmentId;

    try {
      const artifacts = await this.recordingService.loadArtifacts(recordingId);
      const artifact = artifacts.find((a) => a.attachmentId === attachmentId);
      if (!artifact) {
        return false;
      }

      this.currentContent = artifact.content;
      const template = findTemplate(artifact.artifactType);
      this.typeEl.textContent = template?.title ?? artifact.artifactType;
      this.dateEl.textContent = formatDate(artifact.createdAt);
      this.contentEl.textContent = artifact.content;
      this.copyBtn.classList.remove("copied");
      this.copyBtn.textContent = "Copy";
      return true;
    } catch (error) {
      this.onError(error, "Failed to load artifact");
      return false;
    }
  }

  private async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.currentContent);
      this.copyBtn.classList.add("copied");
      this.copyBtn.textContent = "Copied";
      setTimeout(() => {
        this.copyBtn.classList.remove("copied");
        this.copyBtn.textContent = "Copy";
      }, 2000);
    } catch (error) {
      this.onError(error, "Failed to copy to clipboard");
    }
  }

  private async deleteArtifact(): Promise<void> {
    if (!confirm("Delete this document? This cannot be undone.")) {
      return;
    }

    try {
      await this.recordingService.deleteArtifact({
        recordingId: this.currentRecordingId,
        attachmentId: this.currentAttachmentId,
      });
      this.onDeleted(this.currentRecordingId);
    } catch (error) {
      this.onError(error, "Failed to delete artifact");
    }
  }
}

function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
