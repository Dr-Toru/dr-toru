import { RecordingService } from "./recording-service";

const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 20;
const LOUD_SPEECH_RMS = 0.15;
const BAR_SCALE = [0.7, 1.0, 0.85, 0.6] as const;

export function levelToHeight(rms: number): number {
  if (rms <= 0) return MIN_BAR_HEIGHT;
  const normalized = Math.sqrt(Math.min(rms / LOUD_SPEECH_RMS, 1));
  return MIN_BAR_HEIGHT + (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * normalized;
}

export interface RecordingViewControllerOptions {
  transcriptEl: HTMLTextAreaElement;
  transcribeBtn: HTMLButtonElement;
  timerEl: HTMLElement;
  barEls: readonly HTMLElement[];
  typingIndicatorEl: HTMLElement;
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
  | { status: "blocked" }
  | { status: "error" };

export class RecordingViewController {
  private readonly transcriptEl: HTMLTextAreaElement;
  private readonly transcribeBtn: HTMLButtonElement;
  private readonly timerEl: HTMLElement;
  private readonly barEls: readonly HTMLElement[];
  private readonly typingIndicatorEl: HTMLElement;
  private readonly recordingService: RecordingService;
  private readonly onToggleRecording: () => Promise<void>;
  private readonly onRecordingsChanged: () => void;
  private readonly onError: (error: unknown, context: string) => void;
  private context: RecordingContext | null = null;
  private liveTranscript = "";
  private recording = false;
  private available = false;
  private toggling = false;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private recordingStartTime: number | null = null;

  constructor(options: RecordingViewControllerOptions) {
    this.transcriptEl = options.transcriptEl;
    this.transcribeBtn = options.transcribeBtn;
    this.timerEl = options.timerEl;
    this.barEls = options.barEls;
    this.typingIndicatorEl = options.typingIndicatorEl;
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
      if (recordingId && this.context?.recordingId === recordingId) {
        return { status: "opened", recordingId };
      }

      if (this.recording) {
        return { status: "blocked" };
      }

      if (recordingId === null) {
        this.resetTimer();
        this.context = createEmptyContext(
          this.recordingService.createDraftRecordingId(),
        );
        this.liveTranscript = "";
        this.render();
        return { status: "opened", recordingId: this.context.recordingId };
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
      return { status: "error" };
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
    if (recording) {
      this.recordingStartTime = Date.now();
      this.updateTimer();
      this.timerInterval = setInterval(() => this.updateTimer(), 1000);
      this.showTypingIndicator();
    } else {
      this.clearTimerInterval();
      this.resetBars();
      this.hideTypingIndicator();
    }
    this.render();
  }

  setLevel(rms: number): void {
    if (!this.recording || this.barEls.length === 0) return;
    const base = levelToHeight(rms);
    for (let i = 0; i < this.barEls.length; i++) {
      const bar = this.barEls[i];
      if (!bar) continue;
      const scale = BAR_SCALE[i] ?? 1;
      bar.style.height = `${Math.max(MIN_BAR_HEIGHT, base * scale)}px`;
    }
  }

  setLiveTranscript(transcript: string): void {
    this.liveTranscript = transcript;
    if (transcript) {
      this.hideTypingIndicator();
    }
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
      this.liveTranscript = "";
      this.renderTranscript();
    } catch (error) {
      this.onError(error, "Failed to save transcript");
      this.liveTranscript = chunk;
      this.renderTranscript();
      throw error;
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
    this.timerEl.classList.toggle("recording", this.recording);
    this.renderTranscript();
  }

  private renderTranscript(): void {
    const base = this.context?.transcript ?? "";
    const text = appendTranscript(base, this.liveTranscript);
    this.transcriptEl.value = text;
  }

  private updateTimer(): void {
    if (this.recordingStartTime === null) return;
    const elapsed = Date.now() - this.recordingStartTime;
    this.timerEl.textContent = formatElapsed(elapsed);
  }

  private clearTimerInterval(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private resetBars(): void {
    for (const bar of this.barEls) {
      bar.style.height = `${MIN_BAR_HEIGHT}px`;
    }
  }

  private showTypingIndicator(): void {
    this.typingIndicatorEl.hidden = false;
    this.transcriptEl.dataset.recording = "";
  }

  private hideTypingIndicator(): void {
    this.typingIndicatorEl.hidden = true;
    delete this.transcriptEl.dataset.recording;
  }

  private resetTimer(): void {
    this.clearTimerInterval();
    this.recordingStartTime = null;
    this.timerEl.textContent = "0:00";
    this.timerEl.classList.remove("recording");
  }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
