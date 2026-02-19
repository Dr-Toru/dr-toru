import type { PluginPlatform } from "../plugins";
import { AudioCapture } from "../audio/capture";
import { VadSegmenter, type VadSegmenterConfig } from "../audio/vad-segmenter";
import { asrQueue } from "../runtime/queues";

export interface DictationControllerOptions {
  pluginPlatform: PluginPlatform;
  capture: AudioCapture;
  sampleRate: number;
  silenceRms: number;
  silencePeak: number;
  silenceHangoverMs: number;
  debugMetrics: boolean;
  onStatus: (message: string) => void;
  onTranscript: (text: string) => void;
  onRecordingChange: (recording: boolean) => void;
  onRecordingComplete?: (transcript: string) => Promise<void>;
  onLevel?: (rms: number) => void;
}

const VAD_FRAME_SAMPLES = 2048;
const VAD_SPEECH_ONSET_MS = 150;
const VAD_MAX_SEGMENT_SECS = 18;
const VAD_PRE_ROLL_MS = 200;

export class DictationController {
  private isRecordingValue = false;
  private toggling = false;
  private chunkIdx = 0;
  private transcriptText = "";
  private metricChunkId = 0;
  private overloadDropCount = 0;
  private segmenter: VadSegmenter | null = null;

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
        this.overloadDropCount = 0;
        this.debugMetric("recording-start", {});

        try {
          const vadConfig: VadSegmenterConfig = {
            sampleRate: this.options.sampleRate,
            frameSamples: VAD_FRAME_SAMPLES,
            silenceRms: this.options.silenceRms,
            silencePeak: this.options.silencePeak,
            speechOnsetMs: VAD_SPEECH_ONSET_MS,
            silenceHangoverMs: this.options.silenceHangoverMs,
            maxSegmentSecs: VAD_MAX_SEGMENT_SECS,
            preRollMs: VAD_PRE_ROLL_MS,
          };

          this.segmenter = new VadSegmenter(vadConfig);
          this.segmenter.start((segment) => void this.handleSegment(segment));

          await this.options.capture.startWithFrames(
            (frame) => this.segmenter?.pushFrame(frame),
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

      if (this.segmenter) {
        this.segmenter.flush();
        this.segmenter.stop();
        this.segmenter = null;
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
    if (this.segmenter) {
      this.segmenter.stop();
      this.segmenter = null;
    }
  }

  async shutdown(): Promise<void> {
    this.isRecordingValue = false;
    this.options.onRecordingChange(false);
    await this.options.capture.stop();
    if (this.segmenter) {
      this.segmenter.stop();
      this.segmenter = null;
    }
    await asrQueue.waitForIdle();
    await this.options.pluginPlatform.unloadAsr().catch(() => undefined);
  }

  handleSegment(samples: Float32Array): Promise<void> {
    if (asrQueue.depth >= MAX_ASR_QUEUE_DEPTH) {
      this.overloadDropCount += 1;
      if (
        this.overloadDropCount === 1 ||
        this.overloadDropCount % OVERLOAD_STATUS_EVERY === 0
      ) {
        this.options.onStatus(
          "ASR is behind. Dropping some audio chunks to keep app responsive.",
        );
      }
      this.debugMetric("segment-dropped-overload", {
        count: this.overloadDropCount,
        queueDepth: asrQueue.depth,
        segmentSecs: roundMetric(samples.length / this.options.sampleRate),
      });
      return asrQueue.waitForIdle();
    }

    if (this.overloadDropCount > 0 && asrQueue.depth === 0) {
      this.overloadDropCount = 0;
    }

    const metricId = ++this.metricChunkId;
    const queuedAt = performance.now();

    const task = asrQueue.enqueue(async () => {
      const queueWaitMs = performance.now() - queuedAt;
      await this.processSegment(samples, metricId, queueWaitMs);
    });

    this.debugMetric("segment-queued", {
      id: metricId,
      queueDepth: asrQueue.depth,
      segmentSecs: roundMetric(samples.length / this.options.sampleRate),
    });
    return task;
  }

  private async processSegment(
    samples: Float32Array,
    metricId = -1,
    queueWaitMs = 0,
  ): Promise<void> {
    if (!this.options.pluginPlatform.isAsrReady()) {
      this.debugMetric("segment-dropped-unready", {
        segmentSecs: roundMetric(samples.length / this.options.sampleRate),
      });
      return;
    }

    const inferStartedAt = performance.now();
    this.chunkIdx += 1;
    this.options.onStatus(`Processing segment ${this.chunkIdx}...`);

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
      this.debugMetric("segment-complete", {
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
      this.debugMetric("segment-error", {
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

const MAX_WORD_OVERLAP = 8;
const MIN_SINGLE_TOKEN_OVERLAP_LEN = 2;
const MAX_ASR_QUEUE_DEPTH = 3;
const OVERLOAD_STATUS_EVERY = 6;

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
    if (!suffix) {
      return currentText;
    }
    return appendMergeChunk(currentText, suffix);
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
  return `${currentText}\n${suffix}`;
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

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}
