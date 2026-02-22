import { getLanguage, t } from "../i18n";
import type { PluginPlatform } from "../plugins/platform";
import { getLlmPrompt } from "../prompts";
import { RecordingService } from "./recording-service";

const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 20;
const LOUD_SPEECH_RMS = 0.15;

export function levelToHeight(rms: number): number {
  if (rms <= 0) return MIN_BAR_HEIGHT;
  const normalized = Math.sqrt(Math.min(rms / LOUD_SPEECH_RMS, 1));
  return MIN_BAR_HEIGHT + (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * normalized;
}

export type SubView = "transcript" | "context" | "soap" | "summary";

const SUBVIEW_I18N_KEYS: Record<SubView, string> = {
  transcript: "transcript",
  context: "context",
  soap: "soapNote",
  summary: "summary",
};

export interface RecordingViewControllerOptions {
  transcriptEl: HTMLElement;
  contextNoteEl: HTMLTextAreaElement;
  transcribeBtn: HTMLButtonElement;
  uploadBtn: HTMLButtonElement;
  soapBtn: HTMLButtonElement;
  soapSectionEl: HTMLElement;
  soapContentEl: HTMLElement;
  soapBlankStateEl: HTMLElement;
  soapCopyBtn: HTMLButtonElement;
  soapOverlayEl: HTMLElement;
  treatmentSummaryBtn: HTMLButtonElement;
  treatmentSummarySectionEl: HTMLElement;
  treatmentSummaryContentEl: HTMLElement;
  treatmentSummaryBlankStateEl: HTMLElement;
  treatmentSummaryCopyBtn: HTMLButtonElement;
  treatmentSummaryOverlayEl: HTMLElement;
  backBtn: HTMLElement;
  titleBtn: HTMLButtonElement;
  titleLabel: HTMLElement;
  dropdown: HTMLElement;
  transcriptSubview: HTMLElement;
  contextSubview: HTMLElement;
  soapSubview: HTMLElement;
  summarySubview: HTMLElement;
  timerEl: HTMLElement;
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
  treatmentSummaryAttachmentId: string | null;
  treatmentSummaryText: string;
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
  private readonly soapBlankStateEl: HTMLElement;
  private readonly soapCopyBtn: HTMLButtonElement;
  private readonly soapOverlayEl: HTMLElement;
  private readonly treatmentSummaryBtn: HTMLButtonElement;
  private readonly treatmentSummarySectionEl: HTMLElement;
  private readonly treatmentSummaryContentEl: HTMLElement;
  private readonly treatmentSummaryBlankStateEl: HTMLElement;
  private readonly treatmentSummaryCopyBtn: HTMLButtonElement;
  private readonly treatmentSummaryOverlayEl: HTMLElement;
  private readonly backBtn: HTMLElement;
  private readonly titleBtn: HTMLButtonElement;
  private readonly titleLabel: HTMLElement;
  private readonly dropdown: HTMLElement;
  private readonly subviews: Record<SubView, HTMLElement>;
  private readonly timerEl: HTMLElement;
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
    this.transcribeBtns = [options.transcribeBtn];
    this.uploadBtn = options.uploadBtn;
    this.soapBtn = options.soapBtn;
    this.soapSectionEl = options.soapSectionEl;
    this.soapContentEl = options.soapContentEl;
    this.soapBlankStateEl = options.soapBlankStateEl;
    this.soapCopyBtn = options.soapCopyBtn;
    this.soapOverlayEl = options.soapOverlayEl;
    this.treatmentSummaryBtn = options.treatmentSummaryBtn;
    this.treatmentSummarySectionEl = options.treatmentSummarySectionEl;
    this.treatmentSummaryContentEl = options.treatmentSummaryContentEl;
    this.treatmentSummaryBlankStateEl = options.treatmentSummaryBlankStateEl;
    this.treatmentSummaryCopyBtn = options.treatmentSummaryCopyBtn;
    this.treatmentSummaryOverlayEl = options.treatmentSummaryOverlayEl;
    this.backBtn = options.backBtn;
    this.titleBtn = options.titleBtn;
    this.titleLabel = options.titleLabel;
    this.dropdown = options.dropdown;
    this.subviews = {
      transcript: options.transcriptSubview,
      context: options.contextSubview,
      soap: options.soapSubview,
      summary: options.summarySubview,
    };
    this.timerEl = options.timerEl;
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
    this.treatmentSummaryBtn.addEventListener("click", () => {
      void this.generateTreatmentSummary();
    });
    this.titleBtn.addEventListener("click", () => {
      this.toggleDropdown();
    });
    for (const item of this.dropdown.querySelectorAll<HTMLButtonElement>(
      "[data-view]",
    )) {
      item.addEventListener("click", () => {
        const view = item.dataset.view as SubView;
        this.switchView(view);
      });
    }
    this.contextNoteEl.addEventListener("input", () => {
      this.scheduleContextSave();
    });
    this.render();
  }

  async openRoute(recordingId: string | null): Promise<OpenRouteResult> {
    try {
      if (recordingId && this.context?.recordingId === recordingId) {
        this.switchView("transcript");
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
        this.switchView("transcript");
        this.renderSoap();
        this.renderTreatmentSummary();
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
          const summary = await this.recordingService.loadAttachmentText(
            recordingId,
            "treatment_summary",
          );
          if (summary) {
            this.context.treatmentSummaryAttachmentId = summary.attachmentId;
            this.context.treatmentSummaryText = summary.text;
          }
          this.switchView("transcript");
          this.renderSoap();
          this.renderTreatmentSummary();
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
      this.hideTypingIndicator();
    }
    this.render();
  }

  setUploading(uploading: boolean): void {
    this.uploading = uploading;
    if (!uploading) {
      this.timerEl.textContent = "0:00";
    }
    this.render();
  }

  setModelLoading(modelLoading: boolean): void {
    this.modelLoading = modelLoading;
    this.render();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setLevel(_rms: number): void {
    // Placeholder for future visualization
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
      this.context.treatmentSummaryAttachmentId = null;
      this.context.treatmentSummaryText = "";
      this.renderTreatmentSummary();
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
    this.treatmentSummaryBtn.disabled =
      !this.context?.transcript?.trim() || this.recording || this.generating;

    // Disable navigation while recording
    const navDisabled = this.recording;
    (this.backBtn as HTMLButtonElement).disabled = navDisabled;
    this.titleBtn.disabled = navDisabled;

    this.timerEl.classList.toggle("recording", this.recording);
    if (this.uploading && !this.recording) {
      this.timerEl.textContent = t("transcribing");
    }
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

  private currentElapsed(): string {
    if (this.recordingStartTime === null) return "";
    const ms = this.elapsedOffset + (Date.now() - this.recordingStartTime);
    return formatElapsed(ms);
  }

  private addStoppedTimestamp(): void {
    if (!this.stoppedEl) {
      this.stoppedEl = document.createElement("div");
      this.stoppedEl.className = "transcript-timestamp";
    }
    const now = new Date();
    const time = now.toLocaleString(getLanguage(), {
      hour: "numeric",
      minute: "2-digit",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    this.stoppedEl.textContent = `${t("transcriptStopped")} ${time}`;
  }

  private addTimestamp(): void {
    if (!this.timestampEl) {
      this.timestampEl = document.createElement("div");
      this.timestampEl.className = "transcript-timestamp";
    }
    const now = new Date();
    const time = now.toLocaleString(getLanguage(), {
      hour: "numeric",
      minute: "2-digit",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    this.timestampEl.textContent = `${t("transcriptStarted")} ${time}`;
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

      const soapText = await this.platform.runLlm(
        "soap",
        input,
        getLlmPrompt("soap"),
      );

      const result = await this.recordingService.saveAttachmentText({
        recordingId: this.context.recordingId,
        attachmentId: this.context.soapAttachmentId,
        kind: "soap_note",
        createdBy: "llm",
        text: soapText,
        setActive: false,
        role: "derived",
        sourceAttachmentId: this.context.attachmentId,
        metadata: { language: getLanguage() },
      });

      this.context.soapAttachmentId = result.attachmentId;
      this.context.soapText = soapText;
      this.renderSoap();
      this.switchView("soap");
    } catch (err) {
      this.onError(err, "SOAP generation");
    } finally {
      this.generating = false;
      this.soapOverlayEl.classList.remove("visible");
      this.soapOverlayEl.hidden = true;
      this.render();
    }
  }

  async generateTreatmentSummary(): Promise<void> {
    if (!this.context || this.generating) return;
    if (!this.context.transcript.trim()) return;
    if (!this.context.attachmentId) return;

    this.generating = true;
    this.treatmentSummaryOverlayEl.hidden = false;
    this.treatmentSummaryOverlayEl.classList.add("visible");
    this.render();

    try {
      await this.flushContextSave();

      const transcript = this.context.transcript;
      const context = this.contextNoteEl.value.trim();
      let input = `Transcript:\n${transcript}`;
      if (context) {
        input += `\n\nClinician's Notes:\n${context}`;
      }

      const text = await this.platform.runLlm(
        "treatment_summary",
        input,
        getLlmPrompt("treatment_summary"),
      );

      const result = await this.recordingService.saveAttachmentText({
        recordingId: this.context.recordingId,
        attachmentId: this.context.treatmentSummaryAttachmentId,
        kind: "treatment_summary",
        createdBy: "llm",
        text,
        setActive: false,
        role: "derived",
        sourceAttachmentId: this.context.attachmentId,
        metadata: { language: getLanguage() },
      });

      this.context.treatmentSummaryAttachmentId = result.attachmentId;
      this.context.treatmentSummaryText = text;
      this.renderTreatmentSummary();
      this.switchView("summary");
    } catch (err) {
      this.onError(err, "Treatment summary generation");
    } finally {
      this.generating = false;
      this.treatmentSummaryOverlayEl.classList.remove("visible");
      this.treatmentSummaryOverlayEl.hidden = true;
      this.render();
    }
  }

  switchView(view: SubView): void {
    for (const [v, el] of Object.entries(this.subviews) as [
      SubView,
      HTMLElement,
    ][]) {
      el.hidden = v !== view;
    }
    this.titleLabel.textContent = t(SUBVIEW_I18N_KEYS[view]);
    for (const item of this.dropdown.querySelectorAll("[data-view]")) {
      item.classList.toggle(
        "is-active",
        item.getAttribute("data-view") === view,
      );
    }
    this.closeDropdown();
    this.updateSoapCopyBtn();
    this.updateTreatmentSummaryCopyBtn();
  }

  private toggleDropdown(): void {
    const isOpen = !this.dropdown.hidden;
    if (isOpen) {
      this.closeDropdown();
    } else {
      this.dropdown.hidden = false;
      this.titleBtn.classList.add("is-open");
    }
  }

  private closeDropdown(): void {
    this.dropdown.hidden = true;
    this.titleBtn.classList.remove("is-open");
  }

  private renderSoap(): void {
    const text = this.context?.soapText ?? "";
    if (text) {
      this.soapContentEl.textContent = text;
      this.soapSectionEl.hidden = false;
      this.soapBlankStateEl.hidden = true;
      this.soapBtn.textContent = t("regenerate");
    } else {
      this.soapContentEl.textContent = "";
      this.soapSectionEl.hidden = true;
      this.soapBlankStateEl.hidden = false;
      this.soapBtn.textContent = t("generate");
    }
    this.updateSoapCopyBtn();
  }

  private updateSoapCopyBtn(): void {
    const show = !this.subviews.soap.hidden && !this.soapSectionEl.hidden;
    this.soapCopyBtn.hidden = !show;
  }

  private renderTreatmentSummary(): void {
    const text = this.context?.treatmentSummaryText ?? "";
    if (text) {
      this.treatmentSummaryContentEl.textContent = text;
      this.treatmentSummarySectionEl.hidden = false;
      this.treatmentSummaryBlankStateEl.hidden = true;
      this.treatmentSummaryBtn.textContent = t("regenerate");
    } else {
      this.treatmentSummaryContentEl.textContent = "";
      this.treatmentSummarySectionEl.hidden = true;
      this.treatmentSummaryBlankStateEl.hidden = false;
      this.treatmentSummaryBtn.textContent = t("generate");
    }
    this.updateTreatmentSummaryCopyBtn();
  }

  private updateTreatmentSummaryCopyBtn(): void {
    const show =
      !this.subviews.summary.hidden && !this.treatmentSummarySectionEl.hidden;
    this.treatmentSummaryCopyBtn.hidden = !show;
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
    treatmentSummaryAttachmentId: null,
    treatmentSummaryText: "",
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
    treatmentSummaryAttachmentId: null,
    treatmentSummaryText: "",
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
