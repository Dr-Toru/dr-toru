const SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_SECS = 20;
const DEFAULT_STRIDE_SECS = 2;

/**
 * Split audio samples into overlapping chunks for sequential transcription.
 * Uses fixed-size windows since we have the complete audio upfront.
 *
 * Returns subarrays (views into the original buffer, no copies).
 */
export function chunkAudio(
  samples: Float32Array,
  sampleRate: number = SAMPLE_RATE,
  chunkSecs: number = DEFAULT_CHUNK_SECS,
  strideSecs: number = DEFAULT_STRIDE_SECS,
): Float32Array[] {
  if (samples.length === 0) {
    return [];
  }

  const chunkLen = Math.floor(chunkSecs * sampleRate);
  if (chunkLen >= samples.length) {
    return [samples];
  }

  const strideLen = Math.floor(strideSecs * sampleRate);
  const stepLen = chunkLen - strideLen;
  const chunks: Float32Array[] = [];
  let offset = 0;

  while (offset < samples.length) {
    const end = Math.min(offset + chunkLen, samples.length);
    chunks.push(samples.subarray(offset, end));
    if (end >= samples.length) {
      break;
    }
    offset += stepLen;
  }

  return chunks;
}
