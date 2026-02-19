export interface CaptureConfig {
  sampleRate: number;
}

export type FrameCallback = (frame: Float32Array) => void;
export type LevelCallback = (rms: number) => void;

export class AudioCapture {
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;

  private onFrame: FrameCallback | null = null;
  private onLevel: LevelCallback | null = null;
  private monitoring = false;

  constructor(private readonly config: CaptureConfig) {}

  get isMonitoring(): boolean {
    return this.monitoring;
  }

  /** Open the mic for level monitoring only (no buffering). */
  async monitor(onLevel: LevelCallback): Promise<void> {
    if (this.monitoring) return;
    this.onLevel = onLevel;
    this.monitoring = true;
    await this.openMic();
  }

  /** Stop level monitoring and release the mic. */
  async stopMonitor(): Promise<void> {
    if (!this.monitoring) return;
    this.monitoring = false;
    await this.stop();
  }

  /** Open mic in frame mode: emit raw frames without buffering. */
  async startWithFrames(
    onFrame: FrameCallback,
    onLevel?: LevelCallback,
  ): Promise<void> {
    this.onFrame = onFrame;
    if (onLevel) this.onLevel = onLevel;

    // If already monitoring, just transition -- mic is already open
    if (this.monitoring) {
      this.monitoring = false;
      return;
    }

    await this.openMic();
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
    this.onFrame = null;
    this.onLevel = null;
  }

  private async openMic(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

    this.scriptNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.scriptNode.onaudioprocess = (event) => this.onAudioProcess(event);
    this.sourceNode.connect(this.scriptNode);
    this.scriptNode.connect(this.audioCtx.destination);
  }

  private onAudioProcess(event: AudioProcessingEvent): void {
    const input = event.inputBuffer.getChannelData(0);

    if (this.onLevel) {
      this.onLevel(computeRms(input));
    }

    if (this.onFrame) {
      this.onFrame(new Float32Array(input));
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
