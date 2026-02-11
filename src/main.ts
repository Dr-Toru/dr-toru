import * as ort from "onnxruntime-web";

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

const CHUNK_SECS = 5;
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = CHUNK_SECS * SAMPLE_RATE;
const appBase = new URL("./", window.location.href);
const modelsDir = new URL("models/", appBase).href;
const ortDir = new URL("ort/", appBase).href;

const FRAME_LEN = 400;
const HOP_LEN = 160;
const N_FFT = 512;
const N_MELS = 128;
const MEL_LOWER = 125;
const MEL_UPPER = 7500;

const hannWindow = new Float64Array(FRAME_LEN);
for (let idx = 0; idx < FRAME_LEN; idx += 1) {
  hannWindow[idx] = 0.5 * (1 - Math.cos((2 * Math.PI * idx) / FRAME_LEN));
}

let melFilterbank: Float64Array | null = null;

let session: ort.InferenceSession | null = null;
let vocab: MedasrVocab | null = null;
let loadPromise: Promise<void> | null = null;
let isRecording = false;
let processing = false;

let statusEl: HTMLElement;
let transcriptEl: HTMLElement;
let loadBtn: HTMLButtonElement;
let recordBtn: HTMLButtonElement;

let micStream: MediaStream | null = null;
let captureCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;

let pcmBuffer: Float32Array[] = [];
let pcmCount = 0;
let chunkIdx = 0;
let transcriptParts: string[] = [];

window.addEventListener("DOMContentLoaded", () => {
  statusEl = mustEl("status");
  transcriptEl = mustEl("transcript");
  loadBtn = mustBtn("loadBtn");
  recordBtn = mustBtn("recordBtn");

  loadBtn.addEventListener("click", () => {
    void loadModel();
  });
  recordBtn.addEventListener("click", () => {
    void toggleRecording();
  });

  void loadModel();
});

function mustEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

function mustBtn(id: string): HTMLButtonElement {
  const el = mustEl(id);
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return el;
}

function setStatus(message: string): void {
  statusEl.textContent = `Status: ${message}`;
}

async function loadModel(): Promise<void> {
  if (session && vocab) {
    setStatus("Model already loaded");
    return;
  }
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    loadBtn.disabled = true;
    setStatus("Loading vocab in background...");

    try {
      ort.env.wasm.wasmPaths = ortDir;
      ort.env.wasm.numThreads = 1;

      const vocabRes = await fetch(`${modelsDir}medasr_lasr_vocab.json`);
      if (!vocabRes.ok) {
        throw new Error(`Failed to load vocab (${vocabRes.status})`);
      }
      vocab = (await vocabRes.json()) as MedasrVocab;

      setStatus("Loading ONNX model in background...");
      session = await ort.InferenceSession.create(`${modelsDir}medasr_lasr_ctc.onnx`, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });

      setStatus("Model loaded. Ready to record.");
      transcriptEl.textContent = 'Model loaded. Click "Record" to start.';
      recordBtn.disabled = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(`Load failed: ${msg}`);
      loadBtn.disabled = false;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

async function toggleRecording(): Promise<void> {
  if (!session || !vocab) {
    setStatus("Model still loading in background...");
    void loadModel();
    return;
  }

  if (!isRecording) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      captureCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      sourceNode = captureCtx.createMediaStreamSource(micStream);

      scriptNode = captureCtx.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = onAudioProcess;
      sourceNode.connect(scriptNode);
      scriptNode.connect(captureCtx.destination);

      pcmBuffer = [];
      pcmCount = 0;
      chunkIdx = 0;
      transcriptParts = [];
      processing = false;

      transcriptEl.textContent = "";
      isRecording = true;
      recordBtn.textContent = "Stop";
      recordBtn.classList.add("recording");
      setStatus("Recording...");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(`Microphone error: ${msg}`);
    }
    return;
  }

  isRecording = false;

  scriptNode?.disconnect();
  sourceNode?.disconnect();
  await captureCtx?.close();
  micStream?.getTracks().forEach((track) => track.stop());

  scriptNode = null;
  sourceNode = null;
  captureCtx = null;
  micStream = null;

  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");

  if (pcmCount > 0) {
    const tail = drainBuffer();
    await processChunk(tail);
  }

  if (transcriptParts.length === 0) {
    transcriptEl.textContent = "(No speech detected)";
  }
  setStatus("Done");
}

function onAudioProcess(event: AudioProcessingEvent): void {
  if (!isRecording) {
    return;
  }

  const input = event.inputBuffer.getChannelData(0);
  pcmBuffer.push(new Float32Array(input));
  pcmCount += input.length;

  if (pcmCount >= CHUNK_SAMPLES && !processing) {
    const chunk = drainBuffer();
    void processChunk(chunk);
  }
}

function drainBuffer(): Float32Array {
  const samples = new Float32Array(pcmCount);
  let offset = 0;
  for (const chunk of pcmBuffer) {
    const take = Math.min(chunk.length, pcmCount - offset);
    samples.set(chunk.subarray(0, take), offset);
    offset += take;
  }

  pcmBuffer = [];
  pcmCount = 0;
  return samples;
}

async function processChunk(samples: Float32Array): Promise<void> {
  if (!session || !vocab) {
    return;
  }

  processing = true;
  chunkIdx += 1;
  setStatus(`Processing chunk ${chunkIdx}...`);

  try {
    const features = extractMelFeatures(samples);
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
    if (!logits) {
      throw new Error("Model output missing");
    }
    if (logits.dims.length !== 3) {
      throw new Error("Unexpected logits shape");
    }

    const text = decodeCTC(logits.data as ArrayLike<number>, logits.dims, vocab);
    if (text) {
      transcriptParts.push(text);
      transcriptEl.textContent = transcriptParts.join(" ");
    }

    if (isRecording) {
      setStatus("Recording...");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setStatus(`Inference error: ${msg}`);
  } finally {
    processing = false;
  }

  if (pcmCount >= CHUNK_SAMPLES) {
    const next = drainBuffer();
    void processChunk(next);
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
      result.push(tokens[bestIdx] ?? "");
    }
    prevToken = bestIdx;
  }

  return result.join("").replace(/▁/g, " ").trim();
}
