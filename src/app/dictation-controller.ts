import type { PluginPlatform } from "../plugins";
import { AudioCapture, isSilent } from "../audio/capture";
import { asrQueue } from "../runtime/queues";

export interface DictationControllerOptions {
  pluginPlatform: PluginPlatform;
  capture: AudioCapture;
  sampleRate: number;
  chunkSecs: number;
  strideSecs: number;
  silenceRms: number;
  silencePeak: number;
  speechHoldChunks: number;
  silenceProbeEvery: number;
  debugMetrics: boolean;
  onStatus: (message: string) => void;
  onTranscript: (text: string) => void;
  onRecordingChange: (recording: boolean) => void;
  onRecordingComplete?: (transcript: string) => Promise<void>;
  onLevel?: (rms: number) => void;
}

export class DictationController {
  private isRecordingValue = false;
  private toggling = false;
  private chunkIdx = 0;
  private transcriptText = "";
  private metricChunkId = 0;
  private silentChunkSkips = 0;
  private speechHoldRemaining = 0;

  constructor(private readonly options: DictationControllerOptions) {}

  get isRecording(): boolean {
    return this.isRecordingValue;
  }

  isAsrReady(): boolean {
    return this.options.pluginPlatform.isAsrReady();
  }

  async loadModel(): Promise<boolean> {
    if (this.options.pluginPlatform.isAsrReady()) {
      this.options.onStatus("Model already loaded");
      return true;
    }

    this.options.onStatus("Loading model in background...");

    try {
      const provider = await this.options.pluginPlatform.loadAsr();
      this.options.onStatus(`${provider.name} loaded. Ready to record.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatus(`Load failed: ${message}`);
      return false;
    }
  }

  /** Returns the recording state after the toggle attempt. */
  async toggleRecording(): Promise<boolean> {
    if (this.toggling) {
      return this.isRecordingValue;
    }

    this.toggling = true;

    try {
      if (!this.options.pluginPlatform.isAsrReady()) {
        this.options.onStatus("Model still loading in background...");
        return false;
      }

      if (!this.isRecordingValue) {
        this.chunkIdx = 0;
        this.transcriptText = "";
        this.metricChunkId = 0;
        this.silentChunkSkips = 0;
        this.speechHoldRemaining = 0;
        this.debugMetric("recording-start", {
          chunkSecs: this.options.chunkSecs,
          strideSecs: this.options.strideSecs,
        });

        try {
          await this.options.capture.start(
            (chunk) => void this.queueChunk(chunk),
            this.options.onLevel,
          );
          this.options.onTranscript("");
          this.isRecordingValue = true;
          this.options.onRecordingChange(true);
          this.options.onStatus("Recording...");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.options.onStatus(`Microphone error: ${message}`);
        }

        return this.isRecordingValue;
      }

      this.isRecordingValue = false;
      this.options.onRecordingChange(false);
      await this.options.capture.stop();

      const tail = this.options.capture.drain();
      if (tail) {
        void this.queueChunk(tail);
      }

      await asrQueue.waitForIdle();

      let saveFailed = false;
      if (this.transcriptText && this.options.onRecordingComplete) {
        try {
          await this.options.onRecordingComplete(this.transcriptText);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.options.onStatus(`Recording save failed: ${message}`);
          saveFailed = true;
        }
      }
      if (!saveFailed) {
        this.options.onStatus("Done");
      }
      return false;
    } finally {
      this.toggling = false;
    }
  }

  handleAsrCrash(message: string): void {
    this.options.onStatus(`Worker error: ${message}`);
    this.isRecordingValue = false;
    this.options.onRecordingChange(false);
    void this.options.capture.stop();
  }

  async shutdown(): Promise<void> {
    this.isRecordingValue = false;
    this.options.onRecordingChange(false);
    await this.options.capture.stop();
    await asrQueue.waitForIdle();
  }

  private queueChunk(samples: Float32Array): Promise<void> {
    const silent = isSilent(
      samples,
      this.options.silenceRms,
      this.options.silencePeak,
    );

    if (silent) {
      this.silentChunkSkips += 1;
      const shouldProbe =
        this.silentChunkSkips % this.options.silenceProbeEvery === 0;
      const shouldDecode = this.speechHoldRemaining > 0 || shouldProbe;

      if (this.speechHoldRemaining > 0) {
        this.speechHoldRemaining -= 1;
      }

      if (!shouldDecode) {
        if (this.silentChunkSkips === 1 || this.silentChunkSkips % 10 === 0) {
          this.debugMetric("chunk-silent-skip", {
            count: this.silentChunkSkips,
            hold: this.speechHoldRemaining,
            chunkSecs: roundMetric(samples.length / this.options.sampleRate),
          });
        }
        return asrQueue.waitForIdle();
      }

      if (shouldProbe || this.silentChunkSkips === 1) {
        this.debugMetric("chunk-silent-pass", {
          count: this.silentChunkSkips,
          hold: this.speechHoldRemaining,
          probe: shouldProbe ? "1" : "0",
          chunkSecs: roundMetric(samples.length / this.options.sampleRate),
        });
      }
    } else {
      this.silentChunkSkips = 0;
      this.speechHoldRemaining = this.options.speechHoldChunks;
    }

    const metricId = ++this.metricChunkId;
    const queuedAt = performance.now();

    const task = asrQueue.enqueue(async () => {
      const queueWaitMs = performance.now() - queuedAt;
      await this.processChunk(samples, metricId, queueWaitMs);
    });

    this.debugMetric("chunk-queued", {
      id: metricId,
      queueDepth: asrQueue.pendingCount,
      chunkSecs: roundMetric(samples.length / this.options.sampleRate),
    });
    return task;
  }

  private async processChunk(
    samples: Float32Array,
    metricId = -1,
    queueWaitMs = 0,
  ): Promise<void> {
    if (!this.options.pluginPlatform.isAsrReady()) {
      this.debugMetric("chunk-dropped-unready", {
        chunkSecs: roundMetric(samples.length / this.options.sampleRate),
      });
      return;
    }

    const inferStartedAt = performance.now();
    this.chunkIdx += 1;
    this.options.onStatus(`Processing chunk ${this.chunkIdx}...`);

    try {
      const text = await this.options.pluginPlatform.transcribe(samples);
      const mergedText = mergeChunkText(this.transcriptText, text);
      if (mergedText !== this.transcriptText) {
        this.transcriptText = mergedText;
        this.options.onTranscript(this.transcriptText);
      }

      if (this.isRecordingValue) {
        this.options.onStatus("Recording...");
      }
      this.debugMetric("chunk-complete", {
        id: metricId,
        chunkIdx: this.chunkIdx,
        queueWaitMs: roundMetric(queueWaitMs),
        inferMs: roundMetric(performance.now() - inferStartedAt),
        queueDepth: asrQueue.pendingCount,
        active: asrQueue.activeCount,
        textChars: text.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatus(`Inference error: ${message}`);
      this.debugMetric("chunk-error", {
        id: metricId,
        chunkIdx: this.chunkIdx,
        queueWaitMs: roundMetric(queueWaitMs),
        inferMs: roundMetric(performance.now() - inferStartedAt),
        queueDepth: asrQueue.pendingCount,
        active: asrQueue.activeCount,
        message,
      });
    }
  }

  private debugMetric(
    event: string,
    values: Record<string, number | string>,
  ): void {
    if (!this.options.debugMetrics) {
      return;
    }
    console.debug(`[asr-metrics] ${event}`, values);
  }
}

const MAX_WORD_OVERLAP = 20;
const MIN_SINGLE_TOKEN_OVERLAP_LEN = 4;
const MAX_CHAR_OVERLAP = 24;
const MIN_CHAR_OVERLAP = 4;

export function mergeChunkText(currentText: string, nextText: string): string {
  const next = nextText.trim();
  if (!next) {
    return currentText;
  }
  if (!currentText) {
    return next;
  }

  const currentWords = currentText.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const overlapCount = findWordOverlap(currentWords, nextWords);
  if (overlapCount > 0) {
    const suffix = nextWords.slice(overlapCount).join(" ");
    return suffix ? appendMergeChunk(currentText, suffix) : currentText;
  }

  const charOverlap = findCharOverlap(currentText, next);
  if (charOverlap > 0) {
    const suffix = next.slice(charOverlap).trimStart();
    return suffix ? `${currentText}${suffix}` : currentText;
  }

  return appendMergeChunk(currentText, next);
}

function normalizeMergeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\w]+|[^\w]+$/g, "")
    .trim();
}

function appendMergeChunk(currentText: string, suffix: string): string {
  if (!suffix) {
    return currentText;
  }
  if (!currentText) {
    return suffix;
  }
  if (/\s$/.test(currentText) || /^[,.;:!?)]/.test(suffix)) {
    return `${currentText}${suffix}`;
  }
  return `${currentText} ${suffix}`;
}

function findWordOverlap(currentWords: string[], nextWords: string[]): number {
  const maxOverlap = Math.min(
    currentWords.length,
    nextWords.length,
    MAX_WORD_OVERLAP,
  );

  for (let size = maxOverlap; size > 0; size -= 1) {
    let match = true;
    for (let idx = 0; idx < size; idx += 1) {
      const left = normalizeMergeToken(
        currentWords[currentWords.length - size + idx],
      );
      const right = normalizeMergeToken(nextWords[idx]);
      if (!left || !right || left !== right) {
        match = false;
        break;
      }
    }

    if (!match) {
      continue;
    }

    if (size === 1) {
      const token = normalizeMergeToken(currentWords[currentWords.length - 1]);
      if (token.length < MIN_SINGLE_TOKEN_OVERLAP_LEN) {
        return 0;
      }
    }

    return size;
  }

  return 0;
}

function findCharOverlap(currentText: string, nextText: string): number {
  const left = currentText.toLowerCase();
  const right = nextText.toLowerCase();
  const maxSize = Math.min(left.length, right.length, MAX_CHAR_OVERLAP);

  for (let size = maxSize; size >= MIN_CHAR_OVERLAP; size -= 1) {
    const tail = left.slice(-size);
    const head = right.slice(0, size);
    if (tail !== head) {
      continue;
    }
    if (!/[a-z0-9]/i.test(head)) {
      continue;
    }
    return size;
  }

  return 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}
