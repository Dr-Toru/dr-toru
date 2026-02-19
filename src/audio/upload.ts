export async function decodeAudioFileToSamples(
  file: Blob,
  targetRate: number,
): Promise<Float32Array> {
  if (typeof AudioContext === "undefined") {
    throw new Error("Audio decoding is unavailable in this runtime.");
  }
  if (targetRate <= 0 || !Number.isFinite(targetRate)) {
    throw new Error("Invalid target sample rate.");
  }

  const sourceBytes = await file.arrayBuffer();
  const decodeContext = new AudioContext();

  try {
    // Some engines detach the incoming buffer during decode, so pass a copy.
    const decoded = await decodeContext.decodeAudioData(sourceBytes.slice(0));
    if (decoded.length === 0) {
      throw new Error("No audio data found in uploaded file.");
    }
    const mono = mixToMono(decoded);
    return resampleLinear(mono, decoded.sampleRate, targetRate);
  } finally {
    await decodeContext.close().catch(() => undefined);
  }
}

interface AudioBufferLike {
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export function mixToMono(buffer: AudioBufferLike): Float32Array {
  const channelCount = Math.max(buffer.numberOfChannels, 1);
  const mono = new Float32Array(buffer.length);

  for (let channelIdx = 0; channelIdx < channelCount; channelIdx += 1) {
    const channel = buffer.getChannelData(channelIdx);
    const sampleCount = Math.min(channel.length, mono.length);
    for (let sampleIdx = 0; sampleIdx < sampleCount; sampleIdx += 1) {
      mono[sampleIdx] += channel[sampleIdx] / channelCount;
    }
  }

  return mono;
}

export function resampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (samples.length === 0) {
    return new Float32Array();
  }
  if (sourceRate <= 0 || targetRate <= 0) {
    throw new Error("Sample rates must be positive.");
  }
  if (sourceRate === targetRate) {
    return samples.slice();
  }

  // Linear resampling keeps implementation simple with acceptable speech quality.
  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const resampled = new Float32Array(targetLength);

  for (let targetIdx = 0; targetIdx < targetLength; targetIdx += 1) {
    const sourcePos = targetIdx * ratio;
    const leftIdx = Math.floor(sourcePos);
    const rightIdx = Math.min(leftIdx + 1, samples.length - 1);
    const weight = sourcePos - leftIdx;
    const left = samples[leftIdx] ?? 0;
    const right = samples[rightIdx] ?? left;
    resampled[targetIdx] = left + (right - left) * weight;
  }

  return resampled;
}
