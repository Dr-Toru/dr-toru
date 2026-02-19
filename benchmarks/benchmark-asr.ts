/**
 * ASR benchmark script.
 *
 * Tests all decoding/chunk-size combinations against a user-provided
 * audio file with a reference transcript.
 *
 * Usage:
 *   npx tsx benchmarks/benchmark-asr.ts \
 *     --audio benchmarks/test.wav \
 *     --reference "the expected transcription text"
 *
 * If --audio and --reference are omitted, defaults to
 * benchmarks/test.wav and benchmarks/test.txt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ort from "onnxruntime-web";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MedasrVocab {
  blank_id?: number;
  eos_token_id?: number;
  vocab_size?: number;
  tokens: string[];
}

type WasmPtr = number;

interface KenLMModule {
  _kenlm_load(pathPtr: WasmPtr): number;
  _kenlm_state_size(): number;
  _kenlm_bos_state(outPtr: WasmPtr): void;
  _kenlm_score_word(
    inStatePtr: WasmPtr,
    wordPtr: WasmPtr,
    outStatePtr: WasmPtr,
  ): number;
  _kenlm_order(): number;
  _malloc(size: number): WasmPtr;
  _free(ptr: WasmPtr): void;
  HEAPU8: Uint8Array;
  stringToUTF8(str: string, outPtr: WasmPtr, maxBytesToWrite: number): void;
  lengthBytesUTF8(str: string): number;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
}

interface Beam {
  text: string;
  lastTokenId: number;
  logProbBlank: number;
  logProbNonBlank: number;
  lmScore: number;
  lmStatePtr: number;
  wordCount: number;
}

interface FeatureTensor {
  data: Float32Array;
  shape: [number, number, number];
}

interface DecodeConfig {
  beamSearchEnabled: boolean;
  beamWidth: number;
  lmAlpha: number;
  lmBeta: number;
  minTokenLogp: number;
  beamPruneLogp: number;
}

interface BenchResult {
  decoding: string;
  chunkLabel: string;
  wer: number;
  timeSecs: number;
  transcript: string;
}

// ---------------------------------------------------------------------------
// Constants (mirrored from asr.worker.ts)
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const FRAME_LEN = 400;
const HOP_LEN = 160;
const N_FFT = 512;
const N_MELS = 128;
const MEL_LOWER = 125;
const MEL_UPPER = 7500;
const LOG10_TO_LN = Math.log(10);
const LM_MEMFS_PATH = "/lm.kenlm";

// Symmetric Hann window (periodic=False) matching LasrFeatureExtractor
const hannWindow = new Float64Array(FRAME_LEN);
for (let idx = 0; idx < FRAME_LEN; idx += 1) {
  hannWindow[idx] = 0.5 * (1 - Math.cos((2 * Math.PI * idx) / (FRAME_LEN - 1)));
}

// Decode configs to sweep
const DECODE_CONFIGS: { label: string; config: DecodeConfig }[] = [
  {
    label: "beam-a05",
    config: {
      beamSearchEnabled: true,
      beamWidth: 32,
      lmAlpha: 0.5,
      lmBeta: 1.5,
      minTokenLogp: -10,
      beamPruneLogp: -40,
    },
  },
];

// Paths relative to project root
const ROOT = path.resolve(import.meta.dirname, "..");
const MODEL_PATH = process.env.ASR_MODEL_PATH
  ? path.resolve(process.env.ASR_MODEL_PATH)
  : path.join(ROOT, "public/models/medasr_lasr_ctc_int8.onnx");
const VOCAB_PATH = path.join(ROOT, "public/models/medasr_lasr_vocab.json");
const LM_PATH = path.join(ROOT, "public/models/lm_6.kenlm");
const KENLM_JS_PATH = path.join(ROOT, "public/kenlm/kenlm.js");
const KENLM_WASM_PATH = path.join(ROOT, "public/kenlm/kenlm.wasm");

const CHUNK_SIZES = [15, Infinity]; // seconds (trimmed for iteration speed)

const benchFlags = { debugBeamSearch: false };

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  audioPath: string;
  reference: string;
  verbose: boolean;
} {
  const args = process.argv.slice(2);
  const benchDir = path.join(ROOT, "benchmarks");
  let audioPath = "";
  let reference = "";
  let verbose = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--audio" && args[i + 1]) {
      audioPath = args[++i];
    } else if (args[i] === "--reference" && args[i + 1]) {
      reference = args[++i];
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      verbose = true;
    }
  }
  if (!audioPath) {
    audioPath = path.join(benchDir, "test.wav");
  }
  if (!reference) {
    const refFile = path.join(benchDir, "test.txt");
    if (fs.existsSync(refFile)) {
      reference = fs.readFileSync(refFile, "utf-8").trim();
    }
  }
  if (!audioPath || !reference) {
    console.error(
      "Usage: npx tsx scripts/benchmark-asr.ts [--audio <wav>] [--reference <text>] [--verbose]",
    );
    process.exit(1);
  }
  return { audioPath: path.resolve(audioPath), reference, verbose };
}

// ---------------------------------------------------------------------------
// WAV decoding (16-bit PCM, mono, 16kHz expected)
// ---------------------------------------------------------------------------

function decodeWav(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Validate RIFF header
  const riff = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  const wave = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Not a valid WAV file");
  }

  // Find "fmt " chunk
  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;

  while (offset < buf.length - 8) {
    const chunkId = String.fromCharCode(
      buf[offset],
      buf[offset + 1],
      buf[offset + 2],
      buf[offset + 3],
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      if (audioFormat !== 1) {
        throw new Error(`Unsupported audio format ${audioFormat} (need PCM=1)`);
      }
      if (bitsPerSample !== 16) {
        throw new Error(
          `Unsupported bits per sample ${bitsPerSample} (need 16)`,
        );
      }
      if (sampleRate !== SAMPLE_RATE) {
        console.warn(
          `Warning: WAV sample rate is ${sampleRate}Hz, expected ${SAMPLE_RATE}Hz`,
        );
      }

      const dataOffset = offset + 8;
      const bytesPerSample = bitsPerSample / 8;
      const totalSamples = Math.floor(
        chunkSize / (bytesPerSample * numChannels),
      );
      const samples = new Float32Array(totalSamples);

      for (let i = 0; i < totalSamples; i += 1) {
        // Take first channel only
        const sampleOffset = dataOffset + i * numChannels * bytesPerSample;
        const int16 = view.getInt16(sampleOffset, true);
        samples[i] = int16 / 32768;
      }

      return samples;
    }

    offset += 8 + chunkSize;
    // Chunks are word-aligned
    if (chunkSize % 2 !== 0) {
      offset += 1;
    }
  }

  throw new Error("No data chunk found in WAV file");
}

// ---------------------------------------------------------------------------
// Mel feature extraction (from asr.worker.ts:383-520)
// ---------------------------------------------------------------------------

function hertzToMel(freq: number): number {
  return 1127 * Math.log(1 + freq / 700);
}

let melFilterbank: Float64Array | null = null;

function buildMelFilterbank(): Float64Array {
  if (melFilterbank) return melFilterbank;

  const numSpecBins = N_FFT / 2 + 1;
  const bandsToZero = 1;
  const nyquist = SAMPLE_RATE / 2;

  const linearFreqs = new Float64Array(numSpecBins - bandsToZero);
  for (let idx = 0; idx < linearFreqs.length; idx += 1) {
    linearFreqs[idx] = ((idx + bandsToZero) / (numSpecBins - 1)) * nyquist;
  }

  const specBinsMel = new Float64Array(linearFreqs.length);
  for (let idx = 0; idx < linearFreqs.length; idx += 1) {
    specBinsMel[idx] = hertzToMel(linearFreqs[idx]);
  }

  const melLower = hertzToMel(MEL_LOWER);
  const melUpper = hertzToMel(MEL_UPPER);
  const edges = new Float64Array(N_MELS + 2);
  for (let idx = 0; idx < edges.length; idx += 1) {
    edges[idx] = melLower + (idx / (N_MELS + 1)) * (melUpper - melLower);
  }

  const filterbank = new Float64Array(numSpecBins * N_MELS);
  for (let specIdx = 0; specIdx < linearFreqs.length; specIdx += 1) {
    const mel = specBinsMel[specIdx];
    for (let melIdx = 0; melIdx < N_MELS; melIdx += 1) {
      const lower = edges[melIdx];
      const center = edges[melIdx + 1];
      const upper = edges[melIdx + 2];
      const lowerSlope = (mel - lower) / (center - lower);
      const upperSlope = (upper - mel) / (upper - center);
      const value = Math.max(0, Math.min(lowerSlope, upperSlope));
      filterbank[(specIdx + bandsToZero) * N_MELS + melIdx] = value;
    }
  }

  melFilterbank = filterbank;
  return filterbank;
}

function fft(re: Float64Array, im: Float64Array, size: number): void {
  for (let idx = 1, bitRev = 0; idx < size; idx += 1) {
    let bit = size >> 1;
    while (bitRev & bit) {
      bitRev ^= bit;
      bit >>= 1;
    }
    bitRev ^= bit;
    if (idx < bitRev) {
      const reTmp = re[idx];
      re[idx] = re[bitRev];
      re[bitRev] = reTmp;
      const imTmp = im[idx];
      im[idx] = im[bitRev];
      im[bitRev] = imTmp;
    }
  }

  for (let len = 2; len <= size; len *= 2) {
    const half = len / 2;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let block = 0; block < size; block += len) {
      let curRe = 1;
      let curIm = 0;
      for (let idx = 0; idx < half; idx += 1) {
        const a = block + idx;
        const b = block + idx + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function extractMelFeatures(audioIn: Float32Array): FeatureTensor {
  let audio = audioIn;
  if (audio.length < FRAME_LEN) {
    const padded = new Float32Array(FRAME_LEN);
    padded.set(audio);
    audio = padded;
  }

  const frames = Math.floor((audio.length - FRAME_LEN) / HOP_LEN) + 1;
  const features = new Float32Array(frames * N_MELS);
  const filterbank = buildMelFilterbank();

  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const bins = N_FFT / 2 + 1;

  for (let frameIdx = 0; frameIdx < frames; frameIdx += 1) {
    const offset = frameIdx * HOP_LEN;
    re.fill(0);
    im.fill(0);

    for (let sampleIdx = 0; sampleIdx < FRAME_LEN; sampleIdx += 1) {
      re[sampleIdx] = audio[offset + sampleIdx] * hannWindow[sampleIdx];
    }

    fft(re, im, N_FFT);

    for (let melIdx = 0; melIdx < N_MELS; melIdx += 1) {
      let sum = 0;
      for (let bin = 0; bin < bins; bin += 1) {
        const power = re[bin] * re[bin] + im[bin] * im[bin];
        sum += power * filterbank[bin * N_MELS + melIdx];
      }
      features[frameIdx * N_MELS + melIdx] = Math.log(Math.max(sum, 1e-5));
    }
  }

  return { data: features, shape: [1, frames, N_MELS] };
}

// ---------------------------------------------------------------------------
// Special tokens (from asr.worker.ts:942-971)
// ---------------------------------------------------------------------------

function isSpecialToken(token: string): boolean {
  if (!token) return true;
  if (/^<[^<>]+>$/.test(token) || /^\{[a-zA-Z0-9_:-]+\}$/.test(token))
    return true;
  if (token === "{" || token === "}" || token === "▁{") return true;
  if (token === "▁") return true;
  return false;
}

function buildSpecialTokenIds(tokens: string[]): Set<number> {
  const ids = new Set<number>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (isSpecialToken(tokens[i])) ids.add(i);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Greedy CTC decoding (from asr.worker.ts:905-940)
// ---------------------------------------------------------------------------

function decodeCTC(
  logits: ArrayLike<number>,
  frames: number,
  vocabSize: number,
  vocabData: MedasrVocab,
  specialTokenIds: Set<number>,
): string {
  const blankId = vocabData.blank_id ?? 0;
  const eosId = vocabData.eos_token_id ?? -1;
  const tokens = vocabData.tokens;
  const result: string[] = [];
  let prevToken = -1;

  for (let frameIdx = 0; frameIdx < frames; frameIdx += 1) {
    let bestIdx = 0;
    let bestVal = logits[frameIdx * vocabSize];
    for (let tokIdx = 1; tokIdx < vocabSize; tokIdx += 1) {
      const score = logits[frameIdx * vocabSize + tokIdx];
      if (score > bestVal) {
        bestVal = score;
        bestIdx = tokIdx;
      }
    }
    if (bestIdx !== blankId && bestIdx !== prevToken) {
      if (bestIdx !== eosId && !specialTokenIds.has(bestIdx)) {
        result.push(tokens[bestIdx] ?? "");
      }
    }
    prevToken = bestIdx;
  }

  return result.join("").replace(/▁/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Beam search with KenLM (from asr.worker.ts:522-899)
// ---------------------------------------------------------------------------

function logsumexp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const max = Math.max(a, b);
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
}

function logSoftmax(
  logits: ArrayLike<number>,
  frames: number,
  vocabSize: number,
): Float32Array {
  const result = new Float32Array(frames * vocabSize);
  for (let t = 0; t < frames; t += 1) {
    const offset = t * vocabSize;
    let max = -Infinity;
    for (let v = 0; v < vocabSize; v += 1) {
      const val = logits[offset + v];
      if (val > max) max = val;
    }
    let sumExp = 0;
    for (let v = 0; v < vocabSize; v += 1) {
      sumExp += Math.exp(logits[offset + v] - max);
    }
    const logSumExp = max + Math.log(sumExp);
    for (let v = 0; v < vocabSize; v += 1) {
      result[offset + v] = logits[offset + v] - logSumExp;
    }
  }
  return result;
}

function beamKey(b: Beam): string {
  return `${b.text}\t${b.lastTokenId}`;
}

function beamCtcScore(b: Beam): number {
  return logsumexp(b.logProbBlank, b.logProbNonBlank);
}

function beamTotalScore(b: Beam, config: DecodeConfig): number {
  return (
    beamCtcScore(b) + config.lmAlpha * b.lmScore + config.lmBeta * b.wordCount
  );
}

const lmTokenCache = new Map<string, string>();
function lmTokenFor(tokenStr: string): string {
  let cached = lmTokenCache.get(tokenStr);
  if (cached === undefined) {
    cached = tokenStr.startsWith("▁") ? "#" + tokenStr.slice(1) : tokenStr;
    lmTokenCache.set(tokenStr, cached);
  }
  return cached;
}

let tokenBufPtr = 0;
let tokenBufSize = 0;

function scoreTokenKenLM(
  mod: KenLMModule,
  inStatePtr: number,
  tokenStr: string,
  kenlmStateSize: number,
): { logProb: number; newStatePtr: number } {
  const lmToken = lmTokenFor(tokenStr);
  const newStatePtr = mod._malloc(kenlmStateSize);
  const needed = mod.lengthBytesUTF8(lmToken) + 1;
  if (needed > tokenBufSize) {
    if (tokenBufPtr) mod._free(tokenBufPtr);
    tokenBufSize = Math.max(needed, 256);
    tokenBufPtr = mod._malloc(tokenBufSize);
  }
  mod.stringToUTF8(lmToken, tokenBufPtr, tokenBufSize);
  const log10prob = mod._kenlm_score_word(inStatePtr, tokenBufPtr, newStatePtr);
  return { logProb: log10prob * LOG10_TO_LN, newStatePtr };
}

function allocBosState(mod: KenLMModule, kenlmStateSize: number): number {
  const ptr = mod._malloc(kenlmStateSize);
  mod._kenlm_bos_state(ptr);
  return ptr;
}

function copyState(
  mod: KenLMModule,
  srcPtr: number,
  kenlmStateSize: number,
): number {
  const dst = mod._malloc(kenlmStateSize);
  mod.HEAPU8.copyWithin(dst, srcPtr, srcPtr + kenlmStateSize);
  return dst;
}

function extendBeam(
  parent: Beam,
  tokenId: number,
  tokenStr: string,
  logProbNonBlank: number,
  mod: KenLMModule,
  kenlmStateSize: number,
): Beam {
  const { logProb, newStatePtr } = scoreTokenKenLM(
    mod,
    parent.lmStatePtr,
    tokenStr,
    kenlmStateSize,
  );
  const isWordBoundary = tokenStr.startsWith("▁");
  const textPart = isWordBoundary ? tokenStr.slice(1) : tokenStr;
  const text =
    isWordBoundary && parent.text
      ? parent.text + " " + textPart
      : parent.text + textPart;
  return {
    text,
    lastTokenId: tokenId,
    logProbBlank: -Infinity,
    logProbNonBlank,
    lmScore: parent.lmScore + logProb,
    lmStatePtr: newStatePtr,
    wordCount: parent.wordCount + (isWordBoundary ? 1 : 0),
  };
}

function mergeInto(map: Map<string, Beam>, beam: Beam, mod: KenLMModule): void {
  const key = beamKey(beam);
  const existing = map.get(key);
  if (existing) {
    existing.logProbBlank = logsumexp(existing.logProbBlank, beam.logProbBlank);
    existing.logProbNonBlank = logsumexp(
      existing.logProbNonBlank,
      beam.logProbNonBlank,
    );
    mod._free(beam.lmStatePtr);
  } else {
    map.set(key, beam);
  }
}

function decodeBeamSearchLM(
  logProbs: Float32Array,
  frames: number,
  vocabSize: number,
  vocabData: MedasrVocab,
  mod: KenLMModule,
  kenlmStateSize: number,
  specialTokenIds: Set<number>,
  config: DecodeConfig,
): string {
  const blankId = vocabData.blank_id ?? 0;
  const eosId = vocabData.eos_token_id ?? -1;
  const tokens = vocabData.tokens;

  const bosPtr = allocBosState(mod, kenlmStateSize);
  let beams: Beam[] = [
    {
      text: "",
      lastTokenId: -1,
      logProbBlank: 0,
      logProbNonBlank: -Infinity,
      lmScore: 0,
      lmStatePtr: bosPtr,
      wordCount: 0,
    },
  ];

  const debugBeam = benchFlags.debugBeamSearch;
  for (let t = 0; t < frames; t += 1) {
    const frameOffset = t * vocabSize;

    let argmaxIdx = 0;
    let argmaxVal = logProbs[frameOffset];
    for (let v = 1; v < vocabSize; v += 1) {
      const val = logProbs[frameOffset + v];
      if (val > argmaxVal) {
        argmaxVal = val;
        argmaxIdx = v;
      }
    }

    // Always include blank — CTC requires it to survive through
    // frames where the model is confident about a non-blank token.
    const candidateTokens: number[] = [argmaxIdx];
    if (argmaxIdx !== blankId) {
      candidateTokens.push(blankId);
    }
    for (let v = 0; v < vocabSize; v += 1) {
      if (
        v !== argmaxIdx &&
        v !== blankId &&
        logProbs[frameOffset + v] >= config.minTokenLogp
      ) {
        if (!specialTokenIds.has(v)) {
          candidateTokens.push(v);
        }
      }
    }

    const nextMap = new Map<string, Beam>();

    for (const beam of beams) {
      for (const c of candidateTokens) {
        const logP = logProbs[frameOffset + c];

        if (c === blankId) {
          const key = beamKey(beam);
          const existing = nextMap.get(key);
          const newBlank =
            logsumexp(beam.logProbBlank, beam.logProbNonBlank) + logP;
          if (existing) {
            existing.logProbBlank = logsumexp(existing.logProbBlank, newBlank);
          } else {
            nextMap.set(key, {
              ...beam,
              lmStatePtr: copyState(mod, beam.lmStatePtr, kenlmStateSize),
              logProbBlank: newBlank,
              logProbNonBlank: -Infinity,
            });
          }
          continue;
        }

        if (c === eosId || specialTokenIds.has(c)) continue;
        const tokenStr = tokens[c] ?? "";
        const isRepeat = c === beam.lastTokenId;

        if (isRepeat) {
          if (beam.logProbBlank > -Infinity) {
            const extended = extendBeam(
              beam,
              c,
              tokenStr,
              beam.logProbBlank + logP,
              mod,
              kenlmStateSize,
            );
            mergeInto(nextMap, extended, mod);
          }
          if (beam.logProbNonBlank > -Infinity) {
            const key = beamKey(beam);
            const existing = nextMap.get(key);
            const newNb = beam.logProbNonBlank + logP;
            if (existing) {
              existing.logProbNonBlank = logsumexp(
                existing.logProbNonBlank,
                newNb,
              );
            } else {
              nextMap.set(key, {
                ...beam,
                lmStatePtr: copyState(mod, beam.lmStatePtr, kenlmStateSize),
                logProbBlank: -Infinity,
                logProbNonBlank: newNb,
              });
            }
          }
        } else {
          const prevTotal = logsumexp(beam.logProbBlank, beam.logProbNonBlank);
          if (prevTotal > -Infinity) {
            const extended = extendBeam(
              beam,
              c,
              tokenStr,
              prevTotal + logP,
              mod,
              kenlmStateSize,
            );
            mergeInto(nextMap, extended, mod);
          }
        }
      }
    }

    for (const beam of beams) {
      mod._free(beam.lmStatePtr);
    }

    if (nextMap.size === 0 && debugBeam) {
      // This should never happen — blank should always produce entries
      console.log(
        `      [beam t=${t}] EMPTY nextMap! beams=${beams.length} candidates=${candidateTokens.length} blankId=${blankId}`,
      );
      const argP = logProbs[frameOffset + argmaxIdx];
      const blankP = logProbs[frameOffset + blankId];
      console.log(
        `        argmax=${argmaxIdx} argmaxP=${argP} blankP=${blankP} isBlankCandidate=${candidateTokens.includes(blankId)}`,
      );
      // Check for NaN
      let nanCount = 0;
      for (let v = 0; v < vocabSize; v += 1) {
        if (Number.isNaN(logProbs[frameOffset + v])) nanCount++;
      }
      if (nanCount > 0) console.log(`        NaN in logProbs: ${nanCount}`);
      // Print beam states
      for (let bi = 0; bi < Math.min(3, beams.length); bi++) {
        const b = beams[bi];
        console.log(
          `        beam[${bi}]: blank=${b.logProbBlank.toFixed(2)} nonblank=${b.logProbNonBlank.toFixed(2)} text="${b.text.slice(0, 20)}"`,
        );
      }
    }

    // Prune: CTC-only threshold to avoid killing text beams via LM penalty,
    // but rank by total score (CTC + LM + word bonus) so LM influences
    // which beams survive the width cut.
    let nextBeams = Array.from(nextMap.values());
    const bestCtc = nextBeams.reduce(
      (best, b) => Math.max(best, beamCtcScore(b)),
      -Infinity,
    );
    nextBeams = nextBeams.filter(
      (b) => beamCtcScore(b) >= bestCtc + config.beamPruneLogp,
    );
    nextBeams.sort(
      (a, b) => beamTotalScore(b, config) - beamTotalScore(a, config),
    );
    if (nextBeams.length > config.beamWidth) {
      for (let i = config.beamWidth; i < nextBeams.length; i += 1) {
        mod._free(nextBeams[i].lmStatePtr);
      }
      nextBeams = nextBeams.slice(0, config.beamWidth);
    }

    beams = nextBeams;
    if (
      debugBeam &&
      (t < 5 || t % 200 === 0 || beams.length === 0 || beams.length < 5)
    ) {
      if (beams.length > 0) {
        const topBeam = beams[0];
        const withText = beams.filter((b) => b.text.length > 0).length;
        const topTextBeam = beams.find((b) => b.text.length > 0);
        console.log(
          `      [beam t=${t}] beams=${beams.length} withText=${withText} topCtc=${beamCtcScore(topBeam).toFixed(2)} topText="${topTextBeam?.text.slice(0, 30) ?? ""}" topTextCtc=${topTextBeam ? beamCtcScore(topTextBeam).toFixed(2) : "N/A"} topTextLm=${topTextBeam?.lmScore.toFixed(2) ?? "N/A"}`,
        );
      } else {
        // Debug: check what nextMap had before pruning
        console.log(
          `      [beam t=${t}] ALL BEAMS PRUNED! nextMap had ${nextMap.size} entries, bestCtc=${bestCtc.toFixed(2)}`,
        );
      }
    }
    if (beams.length === 0) {
      break;
    }
  }

  let bestBeam: Beam | null = null;
  let bestFinalScore = -Infinity;
  for (const beam of beams) {
    const score = beamTotalScore(beam, config);
    if (score > bestFinalScore) {
      bestFinalScore = score;
      bestBeam = beam;
    }
  }
  for (const beam of beams) {
    mod._free(beam.lmStatePtr);
  }

  return bestBeam ? bestBeam.text.trim() : "";
}

// ---------------------------------------------------------------------------
// Chunk text merging (from dictation-controller.ts:301-421)
// ---------------------------------------------------------------------------

const MAX_WORD_OVERLAP = 20;
const MIN_SINGLE_TOKEN_OVERLAP_LEN = 2;
const SHORT_STRIDE_WORD_LEN = 3;
const MAX_CHAR_OVERLAP = 24;
const MIN_CHAR_OVERLAP = 4;

function normalizeMergeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\w]+|[^\w]+$/g, "")
    .trim();
}

function appendMergeChunk(currentText: string, suffix: string): string {
  if (!suffix) return currentText;
  if (!currentText) return suffix;
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
    if (!match) continue;
    if (size === 1) {
      const token = normalizeMergeToken(currentWords[currentWords.length - 1]);
      if (token.length < MIN_SINGLE_TOKEN_OVERLAP_LEN) return 0;
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
    if (tail !== head) continue;
    if (!/[a-z0-9]/i.test(head)) continue;
    return size;
  }
  return 0;
}

function mergeChunkText(currentText: string, nextText: string): string {
  const next = nextText.trim();
  if (!next) return currentText;
  if (!currentText) return next;

  const currentWords = currentText.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const overlapCount = findWordOverlap(currentWords, nextWords);
  if (overlapCount > 0) {
    const suffix = nextWords.slice(overlapCount).join(" ");
    if (!suffix) return currentText;
    if (
      overlapCount === 1 &&
      normalizeMergeToken(nextWords[0]).length <= SHORT_STRIDE_WORD_LEN
    ) {
      return `${currentText} ${suffix}`;
    }
    return appendMergeChunk(currentText, suffix);
  }

  const lastWord = normalizeMergeToken(currentWords[currentWords.length - 1]);
  const firstWord = normalizeMergeToken(nextWords[0]);
  if (
    lastWord &&
    firstWord &&
    lastWord === firstWord &&
    lastWord.length < MIN_SINGLE_TOKEN_OVERLAP_LEN
  ) {
    return `${currentText} ${next}`;
  }

  const charOverlap = findCharOverlap(currentText, next);
  if (charOverlap > 0) {
    const suffix = next.slice(charOverlap).trimStart();
    return suffix ? `${currentText}${suffix}` : currentText;
  }

  return appendMergeChunk(currentText, next);
}

// ---------------------------------------------------------------------------
// WER (word error rate)
// ---------------------------------------------------------------------------

/**
 * WER normalization aligned with MedASR's official evaluate() function:
 *   s = s.lower()
 *   s = s.replace('</s>', '')
 *   s = re.sub(r"[^ a-z0-9']", ' ', s)
 *   s = ' '.join(s.split())
 */
function normalizeForWER(text: string): string[] {
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/<\/s>/g, "");
  normalized = normalized.replace(/[^ a-z0-9']/g, " ");
  return normalized.split(/\s+/).filter(Boolean);
}

function computeWER(reference: string, hypothesis: string): number {
  const ref = normalizeForWER(reference);
  const hyp = normalizeForWER(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  const n = ref.length;
  const m = hyp.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[n][m] / n;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface AudioChunk {
  samples: Float32Array;
}

function chunkAudio(
  audio: Float32Array,
  chunkSecs: number,
  strideSecs: number,
): AudioChunk[] {
  if (!Number.isFinite(chunkSecs) || chunkSecs * SAMPLE_RATE >= audio.length) {
    return [{ samples: audio }];
  }

  const chunkLen = Math.round(chunkSecs * SAMPLE_RATE);
  const strideLen = Math.round(strideSecs * SAMPLE_RATE);
  const stepLen = chunkLen - strideLen;
  const chunks: AudioChunk[] = [];

  for (let offset = 0; offset < audio.length; offset += stepLen) {
    const end = Math.min(offset + chunkLen, audio.length);
    chunks.push({ samples: audio.subarray(offset, end) });
    if (end >= audio.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// ONNX inference
// ---------------------------------------------------------------------------

async function runInference(
  session: ort.InferenceSession,
  samples: Float32Array,
  dumpFeatures?: boolean,
): Promise<{ logits: ArrayLike<number>; frames: number; vocabSize: number }> {
  const features = extractMelFeatures(samples);
  if (dumpFeatures) {
    fs.writeFileSync(
      "/tmp/bench_features_f32.bin",
      Buffer.from(
        features.data.buffer,
        features.data.byteOffset,
        features.data.byteLength,
      ),
    );
    fs.writeFileSync(
      "/tmp/bench_features_shape.txt",
      `${features.shape[1]} ${features.shape[2]}`,
    );
    console.log(
      `  [debug] Saved bench features: ${features.shape[1]}x${features.shape[2]}`,
    );
  }
  const inputTensor = new ort.Tensor("float32", features.data, features.shape);
  const maskTensor = new ort.Tensor(
    "bool",
    new Uint8Array(features.shape[1]).fill(1),
    [1, features.shape[1]],
  );

  const outputs = await session.run({
    input_features: inputTensor,
    attention_mask: maskTensor,
  });

  const logitsName = Object.prototype.hasOwnProperty.call(outputs, "logits")
    ? "logits"
    : session.outputNames[0];
  const logits = outputs[logitsName];
  if (!logits || logits.dims.length !== 3) {
    throw new Error("Unexpected model output");
  }

  const result = {
    logits: logits.data as ArrayLike<number>,
    frames: logits.dims[1],
    vocabSize: logits.dims[2],
  };

  inputTensor.dispose();
  maskTensor.dispose();
  for (const t of Object.values(outputs)) t.dispose();

  return result;
}

// ---------------------------------------------------------------------------
// KenLM loader for Node.js
// ---------------------------------------------------------------------------

async function loadKenLMNode(): Promise<{
  mod: KenLMModule;
  stateSize: number;
}> {
  // Pre-read the WASM binary so Emscripten doesn't try to fetch()
  const wasmBinary = fs.readFileSync(KENLM_WASM_PATH);

  // Import the Emscripten glue
  const factory = (await import(KENLM_JS_PATH)) as {
    default: (opts?: Record<string, unknown>) => Promise<KenLMModule>;
  };
  const mod = await factory.default({
    wasmBinary: wasmBinary.buffer,
  });

  // Load the .kenlm binary into MEMFS
  const lmData = fs.readFileSync(LM_PATH);
  mod.FS.writeFile(LM_MEMFS_PATH, new Uint8Array(lmData));

  // Load the model
  const pathLen = mod.lengthBytesUTF8(LM_MEMFS_PATH) + 1;
  const pathPtr = mod._malloc(pathLen);
  mod.stringToUTF8(LM_MEMFS_PATH, pathPtr, pathLen);
  const ok = mod._kenlm_load(pathPtr);
  mod._free(pathPtr);

  if (!ok) throw new Error("kenlm_load returned failure");

  try {
    mod.FS.unlink(LM_MEMFS_PATH);
  } catch {
    // non-critical
  }

  const stateSize = mod._kenlm_state_size();
  const order = mod._kenlm_order();
  console.log(
    `  KenLM: loaded ${order}-gram language model, stateSize=${stateSize}`,
  );

  // Quick sanity check: score a word
  const bosPtr = mod._malloc(stateSize);
  mod._kenlm_bos_state(bosPtr);
  const outPtr = mod._malloc(stateSize);
  const testWord = "#the";
  const wordLen = mod.lengthBytesUTF8(testWord) + 1;
  const wordPtr = mod._malloc(wordLen);
  mod.stringToUTF8(testWord, wordPtr, wordLen);
  const score = mod._kenlm_score_word(bosPtr, wordPtr, outPtr);
  console.log(`  KenLM sanity check: score("#the") = ${score} (log10)`);
  mod._free(wordPtr);
  mod._free(outPtr);
  mod._free(bosPtr);

  return { mod, stateSize };
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + "...";
}

function printTable(results: BenchResult[]): void {
  const transcriptWidth = 50;
  const decodingWidth = 14;
  const header = [
    padRight("Decoding", decodingWidth),
    padLeft("Chunks", 6),
    padLeft("WER", 7),
    padLeft("Time (s)", 9),
    padRight("Transcript", transcriptWidth),
  ];

  const sep = header.map((h) => "─".repeat(h.length));
  console.log(`┌${sep.join("┬")}┐`);
  console.log(`│${header.join("│")}│`);
  console.log(`├${sep.join("┼")}┤`);

  for (const r of results) {
    const cols = [
      padRight(r.decoding, decodingWidth),
      padLeft(r.chunkLabel, 6),
      padLeft(`${(r.wer * 100).toFixed(1)}%`, 7),
      padLeft(r.timeSecs.toFixed(1), 9),
      padRight(
        truncate(r.transcript.replace(/\n/g, " "), transcriptWidth),
        transcriptWidth,
      ),
    ];
    console.log(`│${cols.join("│")}│`);
  }

  console.log(`└${sep.join("┴")}┘`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { audioPath, reference, verbose } = parseArgs();
  benchFlags.debugBeamSearch = verbose;

  console.log("ASR Benchmark");
  console.log("=============");
  console.log(`Audio: ${audioPath}`);
  console.log(`Reference: "${truncate(reference, 60)}"`);
  console.log();

  // Load audio
  console.log("Loading audio...");
  const audio = decodeWav(audioPath);
  const durationSecs = audio.length / SAMPLE_RATE;
  console.log(
    `  ${audio.length} samples, ${durationSecs.toFixed(1)}s at ${SAMPLE_RATE}Hz`,
  );

  // Load vocab
  console.log("Loading vocab...");
  const vocabData: MedasrVocab = JSON.parse(
    fs.readFileSync(VOCAB_PATH, "utf-8"),
  );
  const specialIds = buildSpecialTokenIds(vocabData.tokens);
  console.log(`  ${vocabData.tokens.length} tokens`);

  // Load ONNX model
  console.log("Loading ONNX model...");
  ort.env.wasm.numThreads = 1;
  const modelData = fs.readFileSync(MODEL_PATH);
  const session = await ort.InferenceSession.create(modelData.buffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  console.log("  ONNX session ready");

  // Load KenLM
  console.log("Loading KenLM...");
  let kenlm: { mod: KenLMModule; stateSize: number } | null = null;
  try {
    kenlm = await loadKenLMNode();
  } catch (e) {
    console.warn(
      "  KenLM load failed, skipping beam+LM:",
      e instanceof Error ? e.message : e,
    );
  }

  console.log();
  console.log("Running benchmarks...");
  console.log();

  const results: BenchResult[] = [];

  for (const chunkSecs of CHUNK_SIZES) {
    const chunkLabel = Number.isFinite(chunkSecs) ? `${chunkSecs}s` : "full";
    const strideSecs = Number.isFinite(chunkSecs)
      ? Math.min(2, chunkSecs * 0.1)
      : 0;

    // Greedy CTC
    {
      const label = `greedy / ${chunkLabel}`;
      process.stdout.write(`  ${padRight(label, 20)}`);
      const chunks = chunkAudio(audio, chunkSecs, strideSecs);
      const start = performance.now();
      let transcript = "";

      for (const chunk of chunks) {
        const { logits, frames, vocabSize } = await runInference(
          session,
          chunk.samples,
        );
        const text = decodeCTC(
          logits,
          frames,
          vocabSize,
          vocabData,
          specialIds,
        );
        transcript = mergeChunkText(transcript, text);
      }

      const elapsed = (performance.now() - start) / 1000;
      const wer = computeWER(reference, transcript);
      results.push({
        decoding: "greedy",
        chunkLabel,
        wer,
        timeSecs: elapsed,
        transcript,
      });
      console.log(
        `WER=${(wer * 100).toFixed(1)}%  time=${elapsed.toFixed(1)}s`,
      );
    }

    // Beam search + KenLM (sweep configs)
    if (kenlm) {
      for (const dc of DECODE_CONFIGS) {
        const label = `${dc.label} / ${chunkLabel}`;
        process.stdout.write(`  ${padRight(label, 24)}`);
        const chunks = chunkAudio(audio, chunkSecs, strideSecs);
        const start = performance.now();
        let transcript = "";

        for (const chunk of chunks) {
          const { logits, frames, vocabSize } = await runInference(
            session,
            chunk.samples,
          );
          const logProbs = logSoftmax(logits, frames, vocabSize);
          let text = decodeBeamSearchLM(
            logProbs,
            frames,
            vocabSize,
            vocabData,
            kenlm.mod,
            kenlm.stateSize,
            specialIds,
            dc.config,
          );
          const beamRaw = text;
          if (!text) {
            text = decodeCTC(logits, frames, vocabSize, vocabData, specialIds);
          }
          if (verbose) {
            console.log(
              `\n    [chunk] beam="${beamRaw.slice(0, 80)}" fallback=${!beamRaw}`,
            );
          }
          transcript = mergeChunkText(transcript, text);
        }

        const elapsed = (performance.now() - start) / 1000;
        const wer = computeWER(reference, transcript);
        results.push({
          decoding: dc.label,
          chunkLabel,
          wer,
          timeSecs: elapsed,
          transcript,
        });
        console.log(
          `WER=${(wer * 100).toFixed(1)}%  time=${elapsed.toFixed(1)}s`,
        );
      }
    }
  }

  console.log();
  printTable(results);

  // Print full transcripts
  console.log();
  console.log("Full transcripts:");
  console.log("─".repeat(70));
  for (const r of results) {
    console.log(`[${r.decoding} / ${r.chunkLabel}]`);
    console.log(r.transcript);
    console.log();
  }

  // Find best
  const best = results.reduce((a, b) => (a.wer < b.wer ? a : b));
  console.log(
    `Best: ${best.decoding} / ${best.chunkLabel} — WER=${(best.wer * 100).toFixed(1)}%`,
  );

  await session.release();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
