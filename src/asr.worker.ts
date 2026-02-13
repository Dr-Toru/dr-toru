/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import type {
  LoadRequest,
  MainToWorkerMessage,
  TranscribeRequest,
  WorkerToMainMessage,
} from "./asr-messages";

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

const hannWindow = new Float64Array(FRAME_LEN);
for (let idx = 0; idx < FRAME_LEN; idx += 1) {
  hannWindow[idx] = 0.5 * (1 - Math.cos((2 * Math.PI * idx) / FRAME_LEN));
}

let melFilterbank: Float64Array | null = null;
let session: ort.InferenceSession | null = null;
let vocab: MedasrVocab | null = null;
let loadTask: Promise<void> | null = null;

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
    ort.env.wasm.numThreads = 2;

    const vocabResult = await loadJsonWithCache<MedasrVocab>(
      message.vocabUrl,
      "vocab",
    );
    vocab = vocabResult.data;

    const modelUrl = message.modelUrl;
    send({
      type: "status",
      message: vocabResult.fromCache
        ? "Loaded cached vocab. Loading ONNX model..."
        : "Vocab fetched. Loading ONNX model...",
    });
    const modelResult = await loadBinaryWithCache(modelUrl, "ONNX model");

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

    send({ type: "load-success" });
  })()
    .catch((error: unknown) => {
      session = null;
      vocab = null;
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

    send({
      type: "transcribe-success",
      requestId: message.requestId,
      text: decodeCTC(logits.data as ArrayLike<number>, logits.dims, vocab),
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
      const token = tokens[bestIdx] ?? "";
      if (bestIdx !== eosId && !isSpecialToken(token)) {
        result.push(token);
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

  return /^<[^<>]+>$/.test(token) || /^\{[a-zA-Z0-9_:-]+\}$/.test(token);
}
