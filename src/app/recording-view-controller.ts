import type { PluginPlatform } from "../plugins/platform";
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
  transcriptEl: HTMLElement;
  contextNoteEl: HTMLTextAreaElement;
  transcribeBtn: HTMLButtonElement;
  headerTranscribeBtn?: HTMLButtonElement;
  uploadBtn: HTMLButtonElement;
  soapBtn: HTMLButtonElement;
  soapSectionEl: HTMLElement;
  soapContentEl: HTMLElement;
  soapOverlayEl: HTMLElement;
  timerEl: HTMLElement;
  barEls: readonly HTMLElement[];
  typingIndicatorEl: HTMLElement;
  recordingService: RecordingService;
  platform: PluginPlatform;
  onToggleRecording: () => Promise<void>;
  onUploadRequested: () => void;
  onRecordingsChanged: () => void;
  onError: (error: unknown, context: string) => void;
}

interface RecordingContext {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
  contextAttachmentId: string | null;
  contextText: string;
  soapAttachmentId: string | null;
  soapText: string;
}

export type OpenRouteResult =
  | { status: "opened"; recordingId: string }
  | { status: "missing"; recordingId: string }
  | { status: "blocked" }
  | { status: "error" };

export class RecordingViewController {
  private readonly transcriptEl: HTMLElement;
  private readonly contextNoteEl: HTMLTextAreaElement;
  private readonly transcribeBtns: readonly HTMLButtonElement[];
  private readonly uploadBtn: HTMLButtonElement;
  private readonly soapBtn: HTMLButtonElement;
  private readonly soapSectionEl: HTMLElement;
  private readonly soapContentEl: HTMLElement;
  private readonly soapOverlayEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly barEls: readonly HTMLElement[];
  private readonly typingIndicatorEl: HTMLElement;
  private readonly recordingService: RecordingService;
  private readonly platform: PluginPlatform;
  private readonly onToggleRecording: () => Promise<void>;
  private readonly onUploadRequested: () => void;
  private readonly onRecordingsChanged: () => void;
  private readonly onError: (error: unknown, context: string) => void;
  private context: RecordingContext | null = null;
  private liveTranscript = "";
  private recording = false;
  private available = false;
  private toggling = false;
  private uploading = false;
  private modelLoading = false;
  private generating = false;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private recordingStartTime: number | null = null;
  private elapsedOffset = 0;
  private contextSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private timestampEl: HTMLElement | null = null;
  private stoppedEl: HTMLElement | null = null;
  private chunkTimestamps: string[] = [];

  constructor(options: RecordingViewControllerOptions) {
    this.transcriptEl = options.transcriptEl;
    this.contextNoteEl = options.contextNoteEl;
    this.transcribeBtns = options.headerTranscribeBtn
      ? [options.headerTranscribeBtn, options.transcribeBtn]
      : [options.transcribeBtn];
    this.uploadBtn = options.uploadBtn;
    this.soapBtn = options.soapBtn;
    this.soapSectionEl = options.soapSectionEl;
    this.soapContentEl = options.soapContentEl;
    this.soapOverlayEl = options.soapOverlayEl;
    this.timerEl = options.timerEl;
    this.barEls = options.barEls;
    this.typingIndicatorEl = options.typingIndicatorEl;
    this.recordingService = options.recordingService;
    this.platform = options.platform;
    this.onToggleRecording = options.onToggleRecording;
    this.onUploadRequested = options.onUploadRequested;
    this.onRecordingsChanged = options.onRecordingsChanged;
    this.onError = options.onError;
    for (const transcribeBtn of this.transcribeBtns) {
      transcribeBtn.addEventListener("click", () => {
        void this.toggleRecording();
      });
    }
    this.uploadBtn.addEventListener("click", () => {
      this.requestUpload();
    });
    this.soapBtn.addEventListener("click", () => {
      void this.generateSoapNote();
    });
    this.contextNoteEl.addEventListener("input", () => {
      this.scheduleContextSave();
    });
    this.render();
  }

  async openRoute(recordingId: string | null): Promise<OpenRouteResult> {
    try {
      if (recordingId && this.context?.recordingId === recordingId) {
        return { status: "opened", recordingId };
      }

      if (this.recording || this.generating) {
        return { status: "blocked" };
      }

      await this.flushContextSave();

      if (recordingId === null) {
        this.resetTimer();
        this.context = createEmptyContext(
          this.recordingService.createDraftRecordingId(),
        );
        this.liveTranscript = "";
        this.contextNoteEl.value = "";
        this.renderSoap();
        this.render();
        return { status: "opened", recordingId: this.context.recordingId };
      }

      if (recordingId) {
        const loaded = await this.recordingService.loadTranscript(recordingId);
        if (loaded) {
          const loadedContext =
            await this.recordingService.loadContext(recordingId);
          this.context = {
            ...mapLoadedContext(loaded),
            contextAttachmentId: loadedContext?.attachmentId ?? null,
            contextText: loadedContext?.context ?? "",
          };
          this.liveTranscript = "";
          this.contextNoteEl.value = this.context.contextText;

          const soap = await this.recordingService.loadAttachmentText(
            recordingId,
            "soap_note",
          );
          if (soap) {
            this.context.soapAttachmentId = soap.attachmentId;
            this.context.soapText = soap.text;
          }
          this.renderSoap();
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
      this.addTimestamp();
      this.updateTimer();
      this.timerInterval = setInterval(() => this.updateTimer(), 1000);
      this.showTypingIndicator();
    } else {
      if (this.recordingStartTime !== null) {
        this.elapsedOffset += Date.now() - this.recordingStartTime;
      }
      this.addStoppedTimestamp();
      this.clearTimerInterval();
      this.resetBars();
      this.hideTypingIndicator();
    }
    this.render();
  }

  setUploading(uploading: boolean): void {
    this.uploading = uploading;
    this.render();
  }

  setModelLoading(modelLoading: boolean): void {
    this.modelLoading = modelLoading;
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
      this.context.soapAttachmentId = null;
      this.context.soapText = "";
      this.renderSoap();
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
    if (
      this.toggling ||
      this.uploading ||
      this.modelLoading ||
      !this.available
    ) {
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
    const actionDisabled =
      !this.available || this.toggling || this.uploading || this.modelLoading;
    for (const transcribeBtn of this.transcribeBtns) {
      transcribeBtn.classList.toggle("recording", this.recording);
      transcribeBtn.classList.toggle(
        "loading",
        this.modelLoading && !this.recording,
      );
      transcribeBtn.classList.toggle(
        "has-transcript",
        !!this.context?.transcript,
      );
      transcribeBtn.disabled = actionDisabled;
    }
    this.uploadBtn.disabled = actionDisabled || this.recording;
    this.soapBtn.disabled =
      !this.context?.transcript?.trim() || this.recording || this.generating;
    this.timerEl.classList.toggle("recording", this.recording);
    this.renderTranscript();
  }

  private requestUpload(): void {
    if (
      this.recording ||
      this.toggling ||
      this.uploading ||
      this.modelLoading ||
      !this.available
    ) {
      return;
    }
    this.onUploadRequested();
  }

  private renderTranscript(): void {
    const el = this.transcriptEl;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

    // Temporarily detach non-chunk elements so they don't interfere with reconciliation
    if (this.typingIndicatorEl.parentElement === el) {
      el.removeChild(this.typingIndicatorEl);
    }
    if (this.timestampEl?.parentElement === el) {
      el.removeChild(this.timestampEl);
    }
    if (this.stoppedEl?.parentElement === el) {
      el.removeChild(this.stoppedEl);
    }

    const base = this.context?.transcript ?? "";
    const full = appendTranscript(base, this.liveTranscript);
    const lines = full ? full.split("\n").filter(Boolean) : [];

    // Record elapsed timestamp for new lines
    for (let i = this.chunkTimestamps.length; i < lines.length; i++) {
      this.chunkTimestamps.push(this.currentElapsed());
    }

    while (el.children.length > lines.length) {
      el.lastElementChild?.remove();
    }
    for (let i = 0; i < lines.length; i++) {
      let chunk = el.children[i] as HTMLElement | undefined;
      if (!chunk) {
        chunk = document.createElement("div");
        chunk.className = "transcript-chunk";
        const time = document.createElement("span");
        time.className = "chunk-time";
        time.textContent = this.chunkTimestamps[i] ?? "";
        const text = document.createElement("p");
        text.className = "chunk-text";
        chunk.append(time, text);
        el.appendChild(chunk);
      }
      const textEl = chunk.querySelector(".chunk-text");
      if (textEl && textEl.textContent !== lines[i]) {
        textEl.textContent = lines[i]!;
      }
    }

    // Insert "started" timestamp before chunks
    if (this.timestampEl) {
      el.insertBefore(this.timestampEl, el.firstChild);
    }

    // Append "stopped" timestamp after chunks
    if (this.stoppedEl) {
      el.appendChild(this.stoppedEl);
    }

    // Append typing indicator as last element when recording
    if (!this.typingIndicatorEl.hidden) {
      el.appendChild(this.typingIndicatorEl);
    }

    el.classList.toggle("is-empty", lines.length === 0 && !this.recording);

    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private updateTimer(): void {
    if (this.recordingStartTime === null) return;
    const elapsed = this.elapsedOffset + (Date.now() - this.recordingStartTime);
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

  private currentElapsed(): string {
    if (this.recordingStartTime === null) return "0:00";
    const ms = this.elapsedOffset + (Date.now() - this.recordingStartTime);
    return formatElapsed(ms);
  }

  private addStoppedTimestamp(): void {
    if (!this.stoppedEl) {
      this.stoppedEl = document.createElement("div");
      this.stoppedEl.className = "transcript-timestamp";
    }
    const now = new Date();
    const time = now.toLocaleString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    this.stoppedEl.textContent = `Transcript stopped ${time}`;
  }

  private addTimestamp(): void {
    if (!this.timestampEl) {
      this.timestampEl = document.createElement("div");
      this.timestampEl.className = "transcript-timestamp";
    }
    const now = new Date();
    const time = now.toLocaleString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    this.timestampEl.textContent = `Transcript started ${time}`;
  }

  private showTypingIndicator(): void {
    this.typingIndicatorEl.hidden = false;
  }

  private hideTypingIndicator(): void {
    this.typingIndicatorEl.hidden = true;
  }

  async generateSoapNote(): Promise<void> {
    if (!this.context || this.generating) return;
    if (!this.context.transcript.trim()) return;
    if (!this.context.attachmentId) return;

    this.generating = true;
    this.soapOverlayEl.hidden = false;
    this.soapOverlayEl.classList.add("visible");
    this.render();

    try {
      await this.flushContextSave();

      const transcript = this.context.transcript;
      const context = this.contextNoteEl.value.trim();
      let input = `Transcript:\n${transcript}`;
      if (context) {
        input += `\n\nClinician's Notes:\n${context}`;
      }

      const soapText = await this.platform.runLlm("soap", input);

      const result = await this.recordingService.saveAttachmentText({
        recordingId: this.context.recordingId,
        attachmentId: this.context.soapAttachmentId,
        kind: "soap_note",
        createdBy: "llm",
        text: soapText,
        setActive: false,
        role: "derived",
        sourceAttachmentId: this.context.attachmentId,
      });

      this.context.soapAttachmentId = result.attachmentId;
      this.context.soapText = soapText;
      this.renderSoap();
    } catch (err) {
      this.onError(err, "SOAP generation");
    } finally {
      this.generating = false;
      this.soapOverlayEl.classList.remove("visible");
      this.soapOverlayEl.hidden = true;
      this.render();
    }
  }

  private renderSoap(): void {
    const text = this.context?.soapText ?? "";
    if (text) {
      this.soapContentEl.textContent = text;
      this.soapSectionEl.hidden = false;
    } else {
      this.soapContentEl.textContent = "";
      this.soapSectionEl.hidden = true;
    }
    this.soapSectionEl.classList.remove("expanded");
  }

  private scheduleContextSave(): void {
    if (this.contextSaveTimer !== null) {
      clearTimeout(this.contextSaveTimer);
    }
    this.contextSaveTimer = setTimeout(() => {
      this.contextSaveTimer = null;
      void this.saveContext();
    }, 1000);
  }

  private async flushContextSave(): Promise<void> {
    if (this.contextSaveTimer !== null) {
      clearTimeout(this.contextSaveTimer);
      this.contextSaveTimer = null;
      await this.saveContext();
    }
  }

  private async saveContext(): Promise<void> {
    if (!this.context) return;
    const text = this.contextNoteEl.value;
    try {
      const saved = await this.recordingService.saveContext({
        recordingId: this.context.recordingId,
        attachmentId: this.context.contextAttachmentId,
        context: text,
      });
      this.context.contextAttachmentId = saved.attachmentId;
      this.context.contextText = saved.context;
      this.onRecordingsChanged();
    } catch (error) {
      this.onError(error, "Failed to save context");
    }
  }

  private resetTimer(): void {
    this.clearTimerInterval();
    this.recordingStartTime = null;
    this.elapsedOffset = 0;
    this.timestampEl?.remove();
    this.timestampEl = null;
    this.stoppedEl?.remove();
    this.stoppedEl = null;
    this.chunkTimestamps = [];
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
    contextAttachmentId: null,
    contextText: "",
    soapAttachmentId: null,
    soapText: "",
  };
}

function mapLoadedContext(loaded: {
  recordingId: string;
  attachmentId: string | null;
  transcript: string;
}): Omit<RecordingContext, "contextAttachmentId" | "contextText"> {
  return {
    recordingId: loaded.recordingId,
    attachmentId: loaded.attachmentId,
    transcript: loaded.transcript,
    soapAttachmentId: null,
    soapText: "",
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
