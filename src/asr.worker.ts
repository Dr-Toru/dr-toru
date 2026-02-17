/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import type {
  LoadRequest,
  MainToWorkerMessage,
  TranscribeRequest,
  WorkerToMainMessage,
} from "./asr-messages";
import {
  DEFAULT_ASR_RUNTIME_CONFIG,
  sanitizeAsrRuntimeConfig,
} from "./asr/runtime-config";
import type { KenLMModule } from "./kenlm";

interface MedasrVocab {
  blank_id?: number;
  eos_token_id?: number;
  vocab_size?: number;
  tokens: string[];
}

interface FeatureTensor {
  data: Float32Array;
  shape: [number, number, number];
}

const workerScope: DedicatedWorkerGlobalScope =
  self as DedicatedWorkerGlobalScope;

const SAMPLE_RATE = 16000;
const FRAME_LEN = 400;
const HOP_LEN = 160;
const N_FFT = 512;
const N_MELS = 128;
const MEL_LOWER = 125;
const MEL_UPPER = 7500;
const MODEL_CACHE_NAME = "asr-model-cache-v1";
const LM_MEMFS_PATH = "/lm.kenlm";
const LOG10_TO_LN = Math.log(10);

const hannWindow = new Float64Array(FRAME_LEN);
for (let idx = 0; idx < FRAME_LEN; idx += 1) {
  hannWindow[idx] = 0.5 * (1 - Math.cos((2 * Math.PI * idx) / FRAME_LEN));
}

let melFilterbank: Float64Array | null = null;
let session: ort.InferenceSession | null = null;
let vocab: MedasrVocab | null = null;
let loadTask: Promise<void> | null = null;
let kenlmModule: KenLMModule | null = null;
let kenlmStateSize = 0;

let specialTokenIds: Set<number> | null = null;
let runtimeConfig = DEFAULT_ASR_RUNTIME_CONFIG;

function send(message: WorkerToMainMessage): void {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  if (message.type === "load") {
    void loadModel(message);
    return;
  }

  void transcribe(message);
};

async function loadModel(message: LoadRequest): Promise<void> {
  runtimeConfig = sanitizeAsrRuntimeConfig(message.runtimeConfig);

  if (session && vocab) {
    send({ type: "load-success" });
    return;
  }
  if (loadTask) {
    return loadTask;
  }

  loadTask = (async () => {
    send({ type: "status", message: "Loading vocab in background..." });
    ort.env.wasm.wasmPaths = message.ortDir;
    ort.env.wasm.numThreads = runtimeConfig.ortThreads;

    const vocabResult = await loadJsonWithCache<MedasrVocab>(
      message.vocabUrl,
      "vocab",
    );
    vocab = vocabResult.data;
    specialTokenIds = buildSpecialTokenIds(vocab.tokens);

    send({
      type: "status",
      message: vocabResult.fromCache
        ? "Loaded cached vocab. Loading ONNX model..."
        : "Vocab fetched. Loading ONNX model...",
    });
    const modelResult = await loadBinaryWithCache(
      message.modelUrl,
      "ONNX model",
    );

    send({
      type: "status",
      message: modelResult.fromCache
        ? "Initializing inference from cached model..."
        : "Initializing inference from downloaded model...",
    });
    session = await ort.InferenceSession.create(modelResult.data, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    // Load KenLM language model (optional — graceful fallback to greedy)
    if (message.lmUrl && message.kenlmDir) {
      await loadKenLM(message.kenlmDir, message.lmUrl);
    }

    send({ type: "load-success" });
  })()
    .catch((error: unknown) => {
      session = null;
      vocab = null;
      specialTokenIds = null;
      const msg = error instanceof Error ? error.message : String(error);
      send({ type: "load-error", message: msg });
    })
    .finally(() => {
      loadTask = null;
    });

  return loadTask;
}

interface CachedLoadResult<T> {
  data: T;
  fromCache: boolean;
}

async function loadJsonWithCache<T>(
  url: string,
  label: string,
): Promise<CachedLoadResult<T>> {
  const result = await fetchWithCache(url, label);
  return {
    data: (await result.response.json()) as T,
    fromCache: result.fromCache,
  };
}

async function loadBinaryWithCache(
  url: string,
  label: string,
): Promise<CachedLoadResult<Uint8Array>> {
  const result = await fetchWithCache(url, label);
  return {
    data: new Uint8Array(await result.response.arrayBuffer()),
    fromCache: result.fromCache,
  };
}

interface CacheFetchResult {
  response: Response;
  fromCache: boolean;
}

async function fetchWithCache(
  url: string,
  label: string,
): Promise<CacheFetchResult> {
  const fetchFromNetwork = async (): Promise<CacheFetchResult> => ({
    response: await fetchRequired(url, label),
    fromCache: false,
  });

  if (typeof caches === "undefined") {
    return fetchFromNetwork();
  }

  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      return { response: cached, fromCache: true };
    }

    const response = await fetchRequired(url, label);
    await cache.put(url, response.clone());
    return { response, fromCache: false };
  } catch {
    return fetchFromNetwork();
  }
}

async function fetchRequired(url: string, label: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${label} (${response.status})`);
  }
  return response;
}

async function loadKenLM(kenlmDir: string, lmUrl: string): Promise<void> {
  try {
    send({ type: "status", message: "Loading language model..." });

    // Dynamic import of the Emscripten glue module
    const factory = (await import(
      /* @vite-ignore */ `${kenlmDir}kenlm.js`
    )) as {
      default: () => Promise<KenLMModule>;
    };
    const mod = await factory.default();

    // Load the .kenlm binary into MEMFS
    const lmResult = await loadBinaryWithCache(lmUrl, "KenLM model");
    mod.FS.writeFile(LM_MEMFS_PATH, lmResult.data);

    // Allocate a C string for the path and call kenlm_load
    const pathLen = mod.lengthBytesUTF8(LM_MEMFS_PATH) + 1;
    const pathPtr = mod._malloc(pathLen);
    mod.stringToUTF8(LM_MEMFS_PATH, pathPtr, pathLen);
    const ok = mod._kenlm_load(pathPtr);
    mod._free(pathPtr);

    if (!ok) {
      throw new Error("kenlm_load returned failure");
    }

    // Clean up MEMFS copy — model is now in KenLM's internal memory
    try {
      mod.FS.unlink(LM_MEMFS_PATH);
    } catch {
      // non-critical
    }

    kenlmModule = mod;
    kenlmStateSize = mod._kenlm_state_size();

    const order = mod._kenlm_order();
    send({
      type: "status",
      message: lmResult.fromCache
        ? `Loaded cached ${order}-gram language model`
        : `Loaded ${order}-gram language model`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("KenLM load failed, using greedy fallback:", msg);
    kenlmModule = null;
    kenlmStateSize = 0;
    send({
      type: "status",
      message: "Language model unavailable — using basic decoding",
    });
  }
}

async function transcribe(message: TranscribeRequest): Promise<void> {
  if (!session || !vocab) {
    send({
      type: "transcribe-error",
      requestId: message.requestId,
      message: "Model not loaded",
    });
    return;
  }

  try {
    const features = extractMelFeatures(message.samples);
    const inputTensor = new ort.Tensor(
      "float32",
      features.data,
      features.shape,
    );
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
    if (!logits) {
      throw new Error("Model output missing");
    }
    if (logits.dims.length !== 3) {
      throw new Error("Unexpected logits shape");
    }

    const rawLogits = logits.data as ArrayLike<number>;
    const frames = logits.dims[1];
    const vocabSize = logits.dims[2];

    let text: string;
    if (kenlmModule && kenlmStateSize > 0) {
      try {
        const logProbs = logSoftmax(rawLogits, frames, vocabSize);
        text = decodeBeamSearchLM(
          logProbs,
          frames,
          vocabSize,
          vocab,
          kenlmModule,
        );
        if (!text) {
          text = decodeCTC(rawLogits, logits.dims, vocab);
        }
      } catch (beamErr) {
        console.error("[beam] error, falling back to greedy:", beamErr);
        text = decodeCTC(rawLogits, logits.dims, vocab);
      }
    } else {
      text = decodeCTC(rawLogits, logits.dims, vocab);
    }

    send({
      type: "transcribe-success",
      requestId: message.requestId,
      text,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    send({
      type: "transcribe-error",
      requestId: message.requestId,
      message: msg,
    });
  }
}

function hertzToMel(freq: number): number {
  return 1127 * Math.log(1 + freq / 700);
}

function buildMelFilterbank(): Float64Array {
  if (melFilterbank) {
    return melFilterbank;
  }

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

  return {
    data: features,
    shape: [1, frames, N_MELS],
  };
}

// ---------------------------------------------------------------------------
// Beam search decoding with KenLM language model
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

interface Beam {
  /** Accumulated text (with spaces at word boundaries). */
  text: string;
  /** Last emitted non-blank token id (for repeat detection). */
  lastTokenId: number;
  /** log P that all alignments producing this prefix end in blank. */
  logProbBlank: number;
  /** log P that all alignments producing this prefix end in non-blank. */
  logProbNonBlank: number;
  /** Accumulated KenLM log-probability (in natural log). */
  lmScore: number;
  /** Pointer to KenLM State on the WASM heap (0 if unallocated). */
  lmStatePtr: number;
  /** Number of word boundaries (▁ tokens) seen. */
  wordCount: number;
}

/** Unique key for merging identical beam prefixes. */
function beamKey(b: Beam): string {
  return `${b.text}\t${b.lastTokenId}`;
}

/** Total CTC log-probability of a beam. */
function beamCtcScore(b: Beam): number {
  return logsumexp(b.logProbBlank, b.logProbNonBlank);
}

/** Combined score used for beam ranking. */
function beamTotalScore(b: Beam): number {
  const decode = runtimeConfig.decode;
  return (
    beamCtcScore(b) + decode.lmAlpha * b.lmScore + decode.lmBeta * b.wordCount
  );
}

// Pre-allocated WASM buffer for token strings in scoreTokenKenLM.
// Avoids ~100K malloc/free cycles per chunk.
let tokenBufPtr = 0;
let tokenBufSize = 0;

// Cache of SentencePiece ▁→# token mappings (vocab is fixed after load).
const lmTokenCache = new Map<string, string>();

function lmTokenFor(tokenStr: string): string {
  let cached = lmTokenCache.get(tokenStr);
  if (cached === undefined) {
    cached = tokenStr.startsWith("▁") ? "#" + tokenStr.slice(1) : tokenStr;
    lmTokenCache.set(tokenStr, cached);
  }
  return cached;
}

/**
 * Score a SentencePiece token via KenLM and advance the LM state.
 * Maps ▁ → # to match the KenLM vocabulary convention.
 * Returns the log-probability in natural log.
 * Allocates a new state on the WASM heap (caller must free the old one if needed).
 */
function scoreTokenKenLM(
  mod: KenLMModule,
  inStatePtr: number,
  tokenStr: string,
): { logProb: number; newStatePtr: number } {
  const lmToken = lmTokenFor(tokenStr);

  const newStatePtr = mod._malloc(kenlmStateSize);

  // Reuse pre-allocated token buffer, growing if needed
  const needed = mod.lengthBytesUTF8(lmToken) + 1;
  if (needed > tokenBufSize) {
    if (tokenBufPtr) mod._free(tokenBufPtr);
    tokenBufSize = Math.max(needed, 256);
    tokenBufPtr = mod._malloc(tokenBufSize);
  }
  mod.stringToUTF8(lmToken, tokenBufPtr, tokenBufSize);

  const log10prob = mod._kenlm_score_word(inStatePtr, tokenBufPtr, newStatePtr);

  return {
    logProb: log10prob * LOG10_TO_LN, // convert log10 → ln
    newStatePtr,
  };
}

/** Allocate a BOS (beginning-of-sentence) KenLM state. */
function allocBosState(mod: KenLMModule): number {
  const ptr = mod._malloc(kenlmStateSize);
  mod._kenlm_bos_state(ptr);
  return ptr;
}

/** Copy a KenLM state on the WASM heap. */
function copyState(mod: KenLMModule, srcPtr: number): number {
  const dst = mod._malloc(kenlmStateSize);
  mod.HEAPU8.copyWithin(dst, srcPtr, srcPtr + kenlmStateSize);
  return dst;
}

function decodeBeamSearchLM(
  logProbs: Float32Array,
  frames: number,
  vocabSize: number,
  vocabData: MedasrVocab,
  mod: KenLMModule,
): string {
  const blankId = vocabData.blank_id ?? 0;
  const eosId = vocabData.eos_token_id ?? -1;
  const tokens = vocabData.tokens;

  // Initialize with a single empty beam
  const bosPtr = allocBosState(mod);
  let beams: Beam[] = [
    {
      text: "",
      lastTokenId: -1,
      logProbBlank: 0, // log(1) = 0
      logProbNonBlank: -Infinity,
      lmScore: 0,
      lmStatePtr: bosPtr,
      wordCount: 0,
    },
  ];

  for (let t = 0; t < frames; t += 1) {
    const frameOffset = t * vocabSize;

    // Token pruning: find argmax and collect tokens above threshold
    let argmaxIdx = 0;
    let argmaxVal = logProbs[frameOffset];
    for (let v = 1; v < vocabSize; v += 1) {
      const val = logProbs[frameOffset + v];
      if (val > argmaxVal) {
        argmaxVal = val;
        argmaxIdx = v;
      }
    }

    const candidateTokens: number[] = [argmaxIdx];
    for (let v = 0; v < vocabSize; v += 1) {
      if (
        v !== argmaxIdx &&
        logProbs[frameOffset + v] >= runtimeConfig.decode.minTokenLogp
      ) {
        if (!specialTokenIds!.has(v) || v === blankId) {
          candidateTokens.push(v);
        }
      }
    }

    // Expand beams
    const nextMap = new Map<string, Beam>();

    for (const beam of beams) {
      for (const c of candidateTokens) {
        const logP = logProbs[frameOffset + c];

        if (c === blankId) {
          // Blank: prefix stays the same, transitions to blank-ending
          const key = beamKey(beam);
          const existing = nextMap.get(key);
          const newBlank =
            logsumexp(beam.logProbBlank, beam.logProbNonBlank) + logP;
          if (existing) {
            existing.logProbBlank = logsumexp(existing.logProbBlank, newBlank);
          } else {
            nextMap.set(key, {
              ...beam,
              lmStatePtr: copyState(mod, beam.lmStatePtr),
              logProbBlank: newBlank,
              logProbNonBlank: -Infinity,
            });
          }
          continue;
        }

        // Skip special tokens (except blank handled above)
        if (c === eosId || specialTokenIds!.has(c)) {
          continue;
        }
        const tokenStr = tokens[c] ?? "";

        // Determine if this is a repeated token
        const isRepeat = c === beam.lastTokenId;

        if (isRepeat) {
          // Repeated token: two paths
          // 1. Extend from blank-ending → new character (l + c)
          if (beam.logProbBlank > -Infinity) {
            const extended = extendBeam(
              beam,
              c,
              tokenStr,
              beam.logProbBlank + logP,
              mod,
            );
            mergeInto(nextMap, extended, mod);
          }
          // 2. Collapse from non-blank-ending → same prefix (l)
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
                lmStatePtr: copyState(mod, beam.lmStatePtr),
                logProbBlank: -Infinity,
                logProbNonBlank: newNb,
              });
            }
          }
        } else {
          // New character: can come from either blank or non-blank path
          const prevTotal = logsumexp(beam.logProbBlank, beam.logProbNonBlank);
          if (prevTotal > -Infinity) {
            const extended = extendBeam(
              beam,
              c,
              tokenStr,
              prevTotal + logP,
              mod,
            );
            mergeInto(nextMap, extended, mod);
          }
        }
      }
    }

    // Free old beam states
    for (const beam of beams) {
      mod._free(beam.lmStatePtr);
    }

    // Prune: sort by total score, keep top configured beam width.
    let nextBeams = Array.from(nextMap.values());
    const bestScore = nextBeams.reduce(
      (best, b) => Math.max(best, beamTotalScore(b)),
      -Infinity,
    );

    // Score-based pruning
    nextBeams = nextBeams.filter(
      (b) =>
        beamTotalScore(b) >= bestScore + runtimeConfig.decode.beamPruneLogp,
    );

    // Top-K pruning
    const beamWidth = runtimeConfig.decode.beamWidth;
    nextBeams.sort((a, b) => beamTotalScore(b) - beamTotalScore(a));
    if (nextBeams.length > beamWidth) {
      // Free pruned beam states
      for (let i = beamWidth; i < nextBeams.length; i += 1) {
        mod._free(nextBeams[i].lmStatePtr);
      }
      nextBeams = nextBeams.slice(0, beamWidth);
    }

    beams = nextBeams;

    if (beams.length === 0) {
      break;
    }
  }

  // Finalize: pick best beam by total score
  let bestBeam: Beam | null = null;
  let bestFinalScore = -Infinity;

  for (const beam of beams) {
    const score = beamTotalScore(beam);
    if (score > bestFinalScore) {
      bestFinalScore = score;
      bestBeam = beam;
    }
  }

  // Free all beam states
  for (const beam of beams) {
    mod._free(beam.lmStatePtr);
  }

  return bestBeam ? bestBeam.text.trim() : "";
}

/**
 * Create a new beam by extending the parent with a new token.
 * Scores each token individually with KenLM (▁ → # mapping).
 */
function extendBeam(
  parent: Beam,
  tokenId: number,
  tokenStr: string,
  logProbNonBlank: number,
  mod: KenLMModule,
): Beam {
  // Score this token with KenLM
  const { logProb, newStatePtr } = scoreTokenKenLM(
    mod,
    parent.lmStatePtr,
    tokenStr,
  );

  // Build readable text: ▁ prefix → space-separated word boundary
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

/** Merge a new beam into the next-frame beam map. */
function mergeInto(map: Map<string, Beam>, beam: Beam, mod: KenLMModule): void {
  const key = beamKey(beam);
  const existing = map.get(key);
  if (existing) {
    existing.logProbBlank = logsumexp(existing.logProbBlank, beam.logProbBlank);
    existing.logProbNonBlank = logsumexp(
      existing.logProbNonBlank,
      beam.logProbNonBlank,
    );
    // Free the duplicate state
    mod._free(beam.lmStatePtr);
  } else {
    map.set(key, beam);
  }
}

// ---------------------------------------------------------------------------
// Greedy CTC decoding (fallback)
// ---------------------------------------------------------------------------

function decodeCTC(
  logits: ArrayLike<number>,
  dims: readonly number[],
  vocabData: MedasrVocab,
): string {
  const frames = dims[1];
  const vocabSize = dims[2];
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
      if (bestIdx !== eosId && !specialTokenIds!.has(bestIdx)) {
        result.push(tokens[bestIdx] ?? "");
      }
    }
    prevToken = bestIdx;
  }

  return result.join("").replace(/▁/g, " ").trim();
}

function isSpecialToken(token: string): boolean {
  if (!token) {
    return true;
  }

  // Full-form special tokens: <...>, {...}
  if (/^<[^<>]+>$/.test(token) || /^\{[a-zA-Z0-9_:-]+\}$/.test(token)) {
    return true;
  }
  // Bare braces and brace fragments (tokens 107, 109, 511)
  if (token === "{" || token === "}" || token === "▁{") {
    return true;
  }
  // Bare SentencePiece word-boundary marker (token 4) — no content, OOV in KenLM
  if (token === "▁") {
    return true;
  }
  return false;
}

/** Build a Set<number> of special token IDs once during vocab load. */
function buildSpecialTokenIds(tokens: string[]): Set<number> {
  const ids = new Set<number>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (isSpecialToken(tokens[i])) {
      ids.add(i);
    }
  }
  return ids;
}
