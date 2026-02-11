import type {
  LoadRequest,
  MainToWorkerMessage,
  TranscribeRequest,
  WorkerToMainMessage,
} from "./asr-messages";

interface PendingChunk {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

const CHUNK_SECS = 5;
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = CHUNK_SECS * SAMPLE_RATE;
const appBase = new URL("./", window.location.href);
const modelsDir = new URL("models/", appBase).href;
const ortDir = new URL("ort/", appBase).href;

let worker: Worker | null = null;
let ready = false;
let loadPromise: Promise<void> | null = null;
let loadDone: (() => void) | null = null;
let loadFail: ((error: Error) => void) | null = null;
let requestId = 0;

const pendingChunks = new Map<number, PendingChunk>();

let isRecording = false;
let processing = false;
let toggling = false;

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
let chunkTask: Promise<void> = Promise.resolve();

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

  window.addEventListener("beforeunload", () => {
    void stopCapture();
    worker?.terminate();
    worker = null;
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

function getWorker(): Worker {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", onWorkerMessage);
  worker.addEventListener("error", onWorkerError);
  return worker;
}

function onWorkerMessage(event: MessageEvent<WorkerToMainMessage>): void {
  const message = event.data;

  if (message.type === "status") {
    setStatus(message.message);
    return;
  }

  if (message.type === "load-success") {
    ready = true;
    setStatus("Model loaded. Ready to record.");
    transcriptEl.textContent = 'Model loaded. Click "Record" to start.';
    recordBtn.disabled = false;
    loadBtn.disabled = true;
    loadDone?.();
    return;
  }

  if (message.type === "load-error") {
    ready = false;
    recordBtn.disabled = true;
    setStatus(`Load failed: ${message.message}`);
    loadBtn.disabled = false;
    loadFail?.(new Error(message.message));
    return;
  }

  const pending = pendingChunks.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingChunks.delete(message.requestId);

  if (message.type === "transcribe-success") {
    pending.resolve(message.text);
    return;
  }

  pending.reject(new Error(message.message));
}

function onWorkerError(event: ErrorEvent): void {
  const msg = event.message || "Worker crashed";
  setStatus(`Worker error: ${msg}`);
  ready = false;
  isRecording = false;
  processing = false;
  loadBtn.disabled = false;
  recordBtn.disabled = true;
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  void stopCapture();

  loadFail?.(new Error(msg));
  loadFail = null;
  loadDone = null;

  for (const pending of pendingChunks.values()) {
    pending.reject(new Error(msg));
  }
  pendingChunks.clear();

  worker?.terminate();
  worker = null;
}

async function loadModel(): Promise<void> {
  if (ready) {
    setStatus("Model already loaded");
    return;
  }
  if (loadPromise) {
    return loadPromise;
  }

  loadBtn.disabled = true;
  setStatus("Loading model in background...");

  const target = getWorker();
  loadPromise = new Promise<void>((resolve, reject) => {
    loadDone = resolve;
    loadFail = reject;
    const message: LoadRequest = {
      type: "load",
      modelsDir,
      ortDir,
    };
    target.postMessage(message satisfies MainToWorkerMessage);
  });

  try {
    await loadPromise;
  } catch {
    // Status is set from worker events.
  } finally {
    loadPromise = null;
    loadDone = null;
    loadFail = null;
  }
}

async function toggleRecording(): Promise<void> {
  if (toggling) {
    return;
  }

  toggling = true;
  recordBtn.disabled = true;

  try {
    if (!ready) {
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
        chunkTask = Promise.resolve();

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
    await stopCapture();

    recordBtn.textContent = "Record";
    recordBtn.classList.remove("recording");

    if (pcmCount > 0) {
      const tail = drainBuffer();
      void queueChunk(tail);
    }

    await waitForChunks();

    if (transcriptParts.length === 0) {
      transcriptEl.textContent = "(No speech detected)";
    }
    setStatus("Done");
  } finally {
    toggling = false;
    recordBtn.disabled = !ready;
  }
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
    void queueChunk(chunk);
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

function queueChunk(samples: Float32Array): Promise<void> {
  chunkTask = chunkTask.catch(() => undefined).then(() => processChunk(samples));
  return chunkTask;
}

async function waitForChunks(): Promise<void> {
  while (true) {
    const task = chunkTask;
    await task;
    if (task === chunkTask) {
      return;
    }
  }
}

async function stopCapture(): Promise<void> {
  scriptNode?.disconnect();
  sourceNode?.disconnect();
  try {
    await captureCtx?.close();
  } catch {
    // Ignore close errors from torn-down contexts.
  }
  micStream?.getTracks().forEach((track) => track.stop());

  scriptNode = null;
  sourceNode = null;
  captureCtx = null;
  micStream = null;
}

function requestChunk(samples: Float32Array): Promise<string> {
  const target = getWorker();
  requestId += 1;
  const nextId = requestId;

  return new Promise<string>((resolve, reject) => {
    pendingChunks.set(nextId, { resolve, reject });
    const message: TranscribeRequest = {
      type: "transcribe",
      requestId: nextId,
      samples,
    };
    target.postMessage(message satisfies MainToWorkerMessage, [samples.buffer]);
  });
}

async function processChunk(samples: Float32Array): Promise<void> {
  if (!ready) {
    return;
  }

  processing = true;
  chunkIdx += 1;
  setStatus(`Processing chunk ${chunkIdx}...`);

  try {
    const text = await requestChunk(samples);
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
    void queueChunk(next);
  }
}
