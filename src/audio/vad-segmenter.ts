import { computeRms, isSilent } from "./capture";

export interface VadSegmenterConfig {
  sampleRate: number;
  frameSamples: number;
  silenceRms: number;
  silencePeak: number;
  speechOnsetMs: number;
  silenceHangoverMs: number;
  maxSegmentSecs: number;
  preRollMs: number;
}

export type SegmentCallback = (samples: Float32Array) => void;

const enum VadState {
  IDLE,
  SPEAKING,
}

export class VadSegmenter {
  private state = VadState.IDLE;
  private onSegment: SegmentCallback | null = null;

  // Frame counts derived from config
  private readonly speechOnsetFrames: number;
  private readonly silenceHangoverFrames: number;
  private readonly maxSegmentSamples: number;
  private readonly preRollFrames: number;

  // Accumulation buffers
  private frames: Float32Array[] = [];
  private sampleCount = 0;
  private frameEnergies: number[] = [];

  // State counters
  private consecutiveSpeech = 0;
  private consecutiveSilence = 0;

  // Pre-roll ring buffer (stores recent frames while IDLE)
  private preRollBuf: Float32Array[] = [];

  constructor(private readonly config: VadSegmenterConfig) {
    const msPerFrame = (config.frameSamples / config.sampleRate) * 1000;
    this.speechOnsetFrames = Math.max(
      1,
      Math.round(config.speechOnsetMs / msPerFrame),
    );
    this.silenceHangoverFrames = Math.max(
      1,
      Math.round(config.silenceHangoverMs / msPerFrame),
    );
    this.maxSegmentSamples = Math.round(
      config.maxSegmentSecs * config.sampleRate,
    );
    this.preRollFrames = Math.max(0, Math.round(config.preRollMs / msPerFrame));
  }

  start(onSegment: SegmentCallback): void {
    this.onSegment = onSegment;
    this.reset();
  }

  stop(): void {
    this.onSegment = null;
    this.reset();
  }

  flush(): void {
    if (this.sampleCount > 0 && this.onSegment) {
      this.emitSegment();
    }
  }

  pushFrame(frame: Float32Array): void {
    if (!this.onSegment) return;

    const silent = isSilent(
      frame,
      this.config.silenceRms,
      this.config.silencePeak,
    );

    if (this.state === VadState.IDLE) {
      this.handleIdle(frame, silent);
    } else {
      this.handleSpeaking(frame, silent);
    }
  }

  private handleIdle(frame: Float32Array, silent: boolean): void {
    if (silent) {
      this.consecutiveSpeech = 0;
      this.pushPreRoll(frame);
      return;
    }

    this.consecutiveSpeech += 1;
    this.pushPreRoll(frame);

    if (this.consecutiveSpeech >= this.speechOnsetFrames) {
      this.state = VadState.SPEAKING;
      this.consecutiveSilence = 0;

      // Prepend pre-roll frames
      for (const pf of this.preRollBuf) {
        this.frames.push(pf);
        this.sampleCount += pf.length;
        this.frameEnergies.push(computeRms(pf));
      }
      this.preRollBuf = [];
    }
  }

  private handleSpeaking(frame: Float32Array, silent: boolean): void {
    this.frames.push(frame);
    this.sampleCount += frame.length;
    this.frameEnergies.push(computeRms(frame));

    if (silent) {
      this.consecutiveSilence += 1;
      this.consecutiveSpeech = 0;

      if (this.consecutiveSilence >= this.silenceHangoverFrames) {
        this.emitSegment();
        this.state = VadState.IDLE;
        this.consecutiveSilence = 0;
      }
    } else {
      this.consecutiveSilence = 0;
      this.consecutiveSpeech += 1;
    }

    // Force-flush long segments
    if (
      this.state === VadState.SPEAKING &&
      this.sampleCount >= this.maxSegmentSamples
    ) {
      this.forceFlush();
    }
  }

  private forceFlush(): void {
    // Scan backward ~2s of frames for lowest energy split point
    const scanFrames = Math.round(
      (2 * this.config.sampleRate) / this.config.frameSamples,
    );
    const startIdx = Math.max(0, this.frameEnergies.length - scanFrames);
    let minIdx = startIdx;
    let minEnergy = Infinity;

    for (let i = startIdx; i < this.frameEnergies.length; i++) {
      if (this.frameEnergies[i] < minEnergy) {
        minEnergy = this.frameEnergies[i];
        minIdx = i;
      }
    }

    // Split: emit frames up to minIdx+1, keep remainder
    const splitFrame = minIdx + 1;
    const emitFrames = this.frames.slice(0, splitFrame);
    const keepFrames = this.frames.slice(splitFrame);

    let emitSamples = 0;
    for (const f of emitFrames) emitSamples += f.length;

    const segment = new Float32Array(emitSamples);
    let offset = 0;
    for (const f of emitFrames) {
      segment.set(f, offset);
      offset += f.length;
    }
    this.onSegment!(segment);

    // Keep remainder as start of next segment
    this.frames = keepFrames;
    this.frameEnergies = this.frameEnergies.slice(splitFrame);
    this.sampleCount = 0;
    for (const f of keepFrames) this.sampleCount += f.length;
  }

  private emitSegment(): void {
    const segment = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const f of this.frames) {
      segment.set(f, offset);
      offset += f.length;
    }
    this.onSegment!(segment);
    this.frames = [];
    this.frameEnergies = [];
    this.sampleCount = 0;
  }

  private pushPreRoll(frame: Float32Array): void {
    if (this.preRollFrames === 0) return;
    this.preRollBuf.push(frame);
    while (this.preRollBuf.length > this.preRollFrames) {
      this.preRollBuf.shift();
    }
  }

  private reset(): void {
    this.state = VadState.IDLE;
    this.frames = [];
    this.sampleCount = 0;
    this.frameEnergies = [];
    this.consecutiveSpeech = 0;
    this.consecutiveSilence = 0;
    this.preRollBuf = [];
  }
}
