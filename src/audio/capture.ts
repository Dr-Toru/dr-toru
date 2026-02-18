export interface CaptureConfig {
  sampleRate: number;
  chunkSamples: number;
  stepSamples: number;
}

export type ChunkCallback = (samples: Float32Array) => void;
export type LevelCallback = (rms: number) => void;

export class AudioCapture {
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;

  private pcmBuffer: Float32Array[] = [];
  private pcmCount = 0;
  private onChunk: ChunkCallback | null = null;
  private onLevel: LevelCallback | null = null;
  private monitoring = false;

  constructor(private readonly config: CaptureConfig) {}

  get bufferedSamples(): number {
    return this.pcmCount;
  }

  get isMonitoring(): boolean {
    return this.monitoring;
  }

  /** Open the mic for level monitoring only (no buffering). */
  async monitor(onLevel: LevelCallback): Promise<void> {
    if (this.monitoring) return;
    this.onLevel = onLevel;
    this.monitoring = true;

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

    this.scriptNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.scriptNode.onaudioprocess = (event) => this.onAudioProcess(event);
    this.sourceNode.connect(this.scriptNode);
    this.scriptNode.connect(this.audioCtx.destination);
  }

  /** Stop level monitoring and release the mic. */
  async stopMonitor(): Promise<void> {
    if (!this.monitoring) return;
    this.monitoring = false;
    await this.stop();
  }

  async start(onChunk: ChunkCallback, onLevel?: LevelCallback): Promise<void> {
    this.onChunk = onChunk;
    if (onLevel) this.onLevel = onLevel;
    this.pcmBuffer = [];
    this.pcmCount = 0;

    // If already monitoring, just transition — mic is already open
    if (this.monitoring) {
      this.monitoring = false;
      return;
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

    this.scriptNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.scriptNode.onaudioprocess = (event) => this.onAudioProcess(event);
    this.sourceNode.connect(this.scriptNode);
    this.scriptNode.connect(this.audioCtx.destination);
  }

  drain(): Float32Array | null {
    if (this.pcmCount === 0) {
      return null;
    }
    const samples = this.readHead(this.pcmCount);
    this.pcmBuffer = [];
    this.pcmCount = 0;
    return samples;
  }

  async stop(): Promise<void> {
    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null;
      this.scriptNode.disconnect();
    }
    this.sourceNode?.disconnect();
    try {
      await this.audioCtx?.close();
    } catch {
      // Ignore close errors from torn-down contexts.
    }
    this.micStream?.getTracks().forEach((track) => track.stop());

    this.scriptNode = null;
    this.sourceNode = null;
    this.audioCtx = null;
    this.micStream = null;
    this.onChunk = null;
    this.onLevel = null;
  }

  private onAudioProcess(event: AudioProcessingEvent): void {
    if (!this.onChunk) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);

    if (this.onLevel) {
      this.onLevel(computeRms(input));
    }

    this.pcmBuffer.push(new Float32Array(input));
    this.pcmCount += input.length;

    if (this.pcmCount >= this.config.chunkSamples) {
      const chunk = this.takeChunkWindow();
      this.onChunk?.(chunk);
    }
  }

  private takeChunkWindow(): Float32Array {
    const samples = this.readHead(this.config.chunkSamples);
    this.discardHead(this.config.stepSamples);
    return samples;
  }

  private readHead(sampleCount: number): Float32Array {
    const takeCount = Math.min(sampleCount, this.pcmCount);
    const samples = new Float32Array(takeCount);
    let offset = 0;
    for (const chunk of this.pcmBuffer) {
      const take = Math.min(chunk.length, takeCount - offset);
      samples.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= takeCount) {
        break;
      }
    }
    return samples;
  }

  private discardHead(sampleCount: number): void {
    let dropCount = Math.min(sampleCount, this.pcmCount);
    while (dropCount > 0) {
      const chunk = this.pcmBuffer[0];
      if (!chunk) {
        break;
      }

      if (dropCount >= chunk.length) {
        dropCount -= chunk.length;
        this.pcmCount -= chunk.length;
        this.pcmBuffer.shift();
        continue;
      }

      this.pcmBuffer[0] = chunk.subarray(dropCount);
      this.pcmCount -= dropCount;
      dropCount = 0;
    }
  }
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let power = 0;
  for (let i = 0; i < samples.length; i++) {
    power += samples[i] * samples[i];
  }
  return Math.sqrt(power / samples.length);
}

export function isSilent(
  samples: Float32Array,
  rmsThreshold: number,
  peakThreshold: number,
): boolean {
  if (samples.length === 0) {
    return true;
  }

  let peak = 0;
  for (let idx = 0; idx < samples.length; idx += 1) {
    const absValue = Math.abs(samples[idx]);
    if (absValue > peak) {
      peak = absValue;
    }
  }

  const rms = computeRms(samples);
  return rms < rmsThreshold && peak < peakThreshold;
}
