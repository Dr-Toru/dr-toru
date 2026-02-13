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
  debugMetrics: boolean;
  onStatus: (message: string) => void;
  onTranscript: (text: string) => void;
  onRecordingChange: (recording: boolean) => void;
}

export class DictationController {
  private isRecordingValue = false;
  private toggling = false;
  private chunkIdx = 0;
  private transcriptText = "";
  private metricChunkId = 0;
  private silentChunkSkips = 0;

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
      this.options.onTranscript('Model loaded. Click "Record" to start.');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onStatus(`Load failed: ${message}`);
      return false;
    }
  }

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
        this.debugMetric("session-start", {
          chunkSecs: this.options.chunkSecs,
          strideSecs: this.options.strideSecs,
        });

        try {
          await this.options.capture.start(
            (chunk) => void this.queueChunk(chunk),
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

      if (!this.transcriptText) {
        this.options.onTranscript("(No speech detected)");
      }
      this.options.onStatus("Done");
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
    if (isSilent(samples, this.options.silenceRms, this.options.silencePeak)) {
      this.silentChunkSkips += 1;
      if (this.silentChunkSkips === 1 || this.silentChunkSkips % 10 === 0) {
        this.debugMetric("chunk-silent-skip", {
          count: this.silentChunkSkips,
          chunkSecs: roundMetric(samples.length / this.options.sampleRate),
        });
      }
      return asrQueue.waitForIdle();
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

function mergeChunkText(currentText: string, nextText: string): string {
  const next = nextText.trim();
  if (!next) {
    return currentText;
  }
  if (!currentText) {
    return next;
  }

  const currentWords = currentText.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const maxOverlap = Math.min(currentWords.length, nextWords.length, 20);
  let overlapCount = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    let match = true;
    for (let idx = 0; idx < size; idx += 1) {
      const left = normalizeMergeToken(
        currentWords[currentWords.length - size + idx],
      );
      const right = normalizeMergeToken(nextWords[idx]);
      if (left !== right) {
        match = false;
        break;
      }
    }

    if (match) {
      overlapCount = size;
      break;
    }
  }

  const suffix = nextWords.slice(overlapCount).join(" ");
  return suffix ? `${currentText} ${suffix}` : currentText;
}

function normalizeMergeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\w]+|[^\w]+$/g, "")
    .trim();
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}
