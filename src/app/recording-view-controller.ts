import { RecordingService } from "./recording-service";

export interface RecordingViewControllerOptions {
  transcriptEl: HTMLTextAreaElement;
  transcribeBtn: HTMLButtonElement;
  recordingService: RecordingService;
  onToggleRecording: () => Promise<void>;
  onRecordingsChanged: () => void;
  onError: (error: unknown, context: string) => void;
}

interface RecordingContext {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
}

export type OpenRouteResult =
  | { status: "opened"; recordingId: string }
  | { status: "missing"; recordingId: string }
  | { status: "error" };

export class RecordingViewController {
  private readonly transcriptEl: HTMLTextAreaElement;
  private readonly transcribeBtn: HTMLButtonElement;
  private readonly recordingService: RecordingService;
  private readonly onToggleRecording: () => Promise<void>;
  private readonly onRecordingsChanged: () => void;
  private readonly onError: (error: unknown, context: string) => void;
  private context: RecordingContext | null = null;
  private liveTranscript = "";
  private recording = false;
  private available = false;
  private toggling = false;

  constructor(options: RecordingViewControllerOptions) {
    this.transcriptEl = options.transcriptEl;
    this.transcribeBtn = options.transcribeBtn;
    this.recordingService = options.recordingService;
    this.onToggleRecording = options.onToggleRecording;
    this.onRecordingsChanged = options.onRecordingsChanged;
    this.onError = options.onError;
    this.transcribeBtn.addEventListener("click", () => {
      void this.toggleRecording();
    });
    this.render();
  }

  async openRoute(recordingId: string | null): Promise<OpenRouteResult> {
    try {
      if (recordingId === null && this.context) {
        return { status: "opened", recordingId: this.context.recordingId };
      }

      if (recordingId && this.context?.recordingId === recordingId) {
        return { status: "opened", recordingId };
      }

      if (recordingId) {
        const loaded = await this.recordingService.loadTranscript(recordingId);
        if (loaded) {
          this.context = mapLoadedContext(loaded);
          this.liveTranscript = "";
          this.render();
          return { status: "opened", recordingId: loaded.recordingId };
        }
        return { status: "missing", recordingId };
      }

      const latestId = await this.recordingService.getLatestRecordingId();
      if (latestId) {
        const loaded = await this.recordingService.loadTranscript(latestId);
        if (loaded) {
          this.context = mapLoadedContext(loaded);
          this.liveTranscript = "";
          this.render();
          return { status: "opened", recordingId: loaded.recordingId };
        }
      }

      this.context = createEmptyContext(
        this.recordingService.createDraftRecordingId(),
      );
      this.liveTranscript = "";
      this.render();
      return { status: "opened", recordingId: this.context.recordingId };
    } catch (error) {
      this.onError(error, "Failed to load recording");
      return { status: "error" };
    }
  }

  setTranscribeAvailable(available: boolean): void {
    this.available = available;
    this.render();
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    this.render();
  }

  setLiveTranscript(transcript: string): void {
    this.liveTranscript = transcript;
    this.renderTranscript();
  }

  async onRecordingComplete(transcript: string): Promise<void> {
    const chunk = transcript.trim();
    if (!chunk) {
      this.liveTranscript = "";
      this.renderTranscript();
      return;
    }

    if (!this.context) {
      this.context = createEmptyContext(
        this.recordingService.createDraftRecordingId(),
      );
    }

    const nextTranscript = appendTranscript(this.context.transcript, chunk);
    try {
      const saved = await this.recordingService.saveTranscript({
        recordingId: this.context.recordingId,
        attachmentId: this.context.attachmentId,
        transcript: nextTranscript,
      });
      this.context.attachmentId = saved.attachmentId;
      this.context.transcript = saved.transcript;
      this.onRecordingsChanged();
    } catch (error) {
      this.onError(error, "Failed to save transcript");
    } finally {
      this.liveTranscript = "";
      this.renderTranscript();
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.toggling || !this.available) {
      return;
    }
    this.toggling = true;
    this.render();
    try {
      await this.onToggleRecording();
    } catch (error) {
      this.onError(error, "Failed to toggle recording");
    } finally {
      this.toggling = false;
      this.render();
    }
  }

  private render(): void {
    this.transcribeBtn.textContent = this.recording ? "Stop" : "Transcribe";
    this.transcribeBtn.classList.toggle("recording", this.recording);
    this.transcribeBtn.disabled = !this.available || this.toggling;
    this.renderTranscript();
  }

  private renderTranscript(): void {
    const base = this.context?.transcript ?? "";
    const text = appendTranscript(base, this.liveTranscript);
    this.transcriptEl.value = text;
  }
}

function createEmptyContext(recordingId: string): RecordingContext {
  return {
    recordingId,
    attachmentId: null,
    transcript: "",
  };
}

function mapLoadedContext(loaded: {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
}): RecordingContext {
  return {
    recordingId: loaded.recordingId,
    attachmentId: loaded.attachmentId,
    transcript: loaded.transcript,
  };
}

function appendTranscript(current: string, next: string): string {
  const right = next.trim();
  if (!right) {
    return current;
  }
  if (!current) {
    return right;
  }
  return `${current}\n${right}`;
}
