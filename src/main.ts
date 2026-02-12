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

const ROUTES = ["transcription", "list", "settings"] as const;
type RouteName = (typeof ROUTES)[number];
const TAB_ROUTES = ["list", "transcription"] as const;
type TabRoute = (typeof TAB_ROUTES)[number];
const DEFAULT_ROUTE: TabRoute = "transcription";
const SPLASH_FADE_MS = 280;

const CHUNK_SECS = 4;
const STRIDE_SECS = 1;
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = Math.floor(CHUNK_SECS * SAMPLE_RATE);
const STRIDE_SAMPLES = Math.floor(STRIDE_SECS * SAMPLE_RATE);
const CHUNK_STEP_SAMPLES = Math.max(1, CHUNK_SAMPLES - STRIDE_SAMPLES);
const SILENCE_RMS = 0.004;
const SILENCE_PEAK = 0.02;
const DEBUG_METRICS = isDebugMetricsEnabled();
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
let toggling = false;

let statusEl: HTMLElement;
let transcriptEl: HTMLElement;
let loadBtn: HTMLButtonElement;
let recordBtn: HTMLButtonElement;
let settingsBtn: HTMLButtonElement;
let navBtns: HTMLButtonElement[] = [];
let currentRoute: RouteName | null = null;
let screenEls: Record<RouteName, HTMLElement>;
let lastMainRoute: TabRoute = DEFAULT_ROUTE;
let splashEl: HTMLElement;
let splashHideTimer: number | null = null;

let micStream: MediaStream | null = null;
let captureCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;

let pcmBuffer: Float32Array[] = [];
let pcmCount = 0;
let chunkIdx = 0;
let transcriptText = "";
let chunkTask: Promise<void> = Promise.resolve();
let queuedChunkCount = 0;
let activeChunkCount = 0;
let metricChunkId = 0;
let silentChunkSkips = 0;

window.addEventListener("DOMContentLoaded", () => {
  statusEl = mustEl("status");
  transcriptEl = mustEl("transcript");
  loadBtn = mustBtn("loadBtn");
  recordBtn = mustBtn("recordBtn");
  settingsBtn = mustBtn("settingsBtn");
  splashEl = mustEl("screen-splash");
  screenEls = {
    transcription: mustEl("screen-transcription"),
    list: mustEl("screen-list"),
    settings: mustEl("screen-settings"),
  };
  navBtns = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-btn[data-route]"));

  for (const navBtn of navBtns) {
    navBtn.addEventListener("click", () => {
      const route = navBtn.dataset.route;
      if (!isTabRoute(route)) {
        return;
      }
      setRoute(route, true);
    });
  }

  settingsBtn.addEventListener("click", () => {
    if (currentRoute === "settings") {
      setRoute(lastMainRoute, true);
      return;
    }
    setRoute("settings", true);
  });

  window.addEventListener("hashchange", () => {
    setRoute(routeFromHash(window.location.hash), false);
  });

  const initialHash = hashValue(window.location.hash);
  if (initialHash) {
    hideSplash(false);
    setRoute(routeFromHash(window.location.hash), true);
  } else {
    setRoute(DEFAULT_ROUTE, true);
    showSplash();
  }

  loadBtn.addEventListener("click", () => {
    void loadModel();
  });
  recordBtn.addEventListener("click", () => {
    void toggleRecording();
  });

  window.addEventListener("beforeunload", () => {
    clearSplashHideTimer();
    void stopCapture();
    worker?.terminate();
    worker = null;
  });

  void loadModel();
});

function isRoute(value: string | undefined): value is RouteName {
  return value !== undefined && ROUTES.includes(value as RouteName);
}

function isTabRoute(value: string | undefined): value is TabRoute {
  return value !== undefined && TAB_ROUTES.includes(value as TabRoute);
}

function hashValue(hash: string): string {
  return hash.replace(/^#/, "");
}

function routeFromHash(hash: string): RouteName {
  const route = hashValue(hash);
  return isRoute(route) ? route : DEFAULT_ROUTE;
}

function setRoute(route: RouteName, syncHash: boolean): void {
  const changed = route !== currentRoute;
  if (!changed) {
    return;
  }

  currentRoute = route;

  for (const name of ROUTES) {
    const isActive = name === route;
    const screen = screenEls[name];
    screen.classList.toggle("is-hidden", !isActive);
    screen.hidden = !isActive;
    screen.setAttribute("aria-hidden", String(!isActive));
  }

  if (changed) {
    const active = screenEls[route];
    active.classList.remove("fade-in");
    void active.offsetWidth;
    active.classList.add("fade-in");
  }

  for (const navBtn of navBtns) {
    const isActive = navBtn.dataset.route === route;
    navBtn.classList.toggle("is-active", isActive);
    if (isActive) {
      navBtn.setAttribute("aria-current", "page");
    } else {
      navBtn.removeAttribute("aria-current");
    }
  }

  const settingsActive = route === "settings";
  settingsBtn.classList.toggle("is-active", settingsActive);
  settingsBtn.setAttribute("aria-pressed", String(settingsActive));

  if (isTabRoute(route)) {
    lastMainRoute = route;
  }

  if (!syncHash) {
    return;
  }

  const hash = `#${route}`;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

function showSplash(): void {
  clearSplashHideTimer();
  splashEl.hidden = false;
  splashEl.setAttribute("aria-hidden", "false");
  splashEl.classList.remove("is-fading");
}

function hideSplash(withFade: boolean): void {
  if (splashEl.hidden) {
    return;
  }

  if (!withFade) {
    splashEl.classList.remove("is-fading");
    splashEl.hidden = true;
    splashEl.setAttribute("aria-hidden", "true");
    return;
  }

  splashEl.classList.add("is-fading");
  clearSplashHideTimer();
  splashHideTimer = window.setTimeout(() => {
    splashHideTimer = null;
    splashEl.hidden = true;
    splashEl.setAttribute("aria-hidden", "true");
    splashEl.classList.remove("is-fading");
  }, SPLASH_FADE_MS);
}

function maybeExitSplash(): void {
  if (splashEl.hidden) {
    return;
  }
  hideSplash(true);
}

function clearSplashHideTimer(): void {
  if (splashHideTimer !== null) {
    window.clearTimeout(splashHideTimer);
    splashHideTimer = null;
  }
}

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
    maybeExitSplash();
    loadDone?.();
    return;
  }

  if (message.type === "load-error") {
    ready = false;
    recordBtn.disabled = true;
    setStatus(`Load failed: ${message.message}`);
    loadBtn.disabled = false;
    maybeExitSplash();
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
  maybeExitSplash();
  ready = false;
  isRecording = false;
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

        scriptNode = captureCtx.createScriptProcessor(2048, 1, 1);
        scriptNode.onaudioprocess = onAudioProcess;
        sourceNode.connect(scriptNode);
        scriptNode.connect(captureCtx.destination);

        pcmBuffer = [];
        pcmCount = 0;
        chunkIdx = 0;
        transcriptText = "";
        chunkTask = Promise.resolve();
        queuedChunkCount = 0;
        activeChunkCount = 0;
        metricChunkId = 0;
        silentChunkSkips = 0;
        debugMetric("session-start", { chunkSecs: CHUNK_SECS, strideSecs: STRIDE_SECS });

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

    if (!transcriptText) {
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

  if (pcmCount >= CHUNK_SAMPLES) {
    const chunk = takeChunkWindow();
    void queueChunk(chunk);
  }
}

function drainBuffer(): Float32Array {
  const samples = readHead(pcmCount);
  pcmBuffer = [];
  pcmCount = 0;
  return samples;
}

function takeChunkWindow(): Float32Array {
  const samples = readHead(CHUNK_SAMPLES);
  discardHead(CHUNK_STEP_SAMPLES);
  return samples;
}

function readHead(sampleCount: number): Float32Array {
  const takeCount = Math.min(sampleCount, pcmCount);
  const samples = new Float32Array(takeCount);
  let offset = 0;
  for (const chunk of pcmBuffer) {
    const take = Math.min(chunk.length, takeCount - offset);
    samples.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= takeCount) {
      break;
    }
  }
  return samples;
}

function discardHead(sampleCount: number): void {
  let dropCount = Math.min(sampleCount, pcmCount);
  while (dropCount > 0) {
    const chunk = pcmBuffer[0];
    if (!chunk) {
      break;
    }

    if (dropCount >= chunk.length) {
      dropCount -= chunk.length;
      pcmCount -= chunk.length;
      pcmBuffer.shift();
      continue;
    }

    pcmBuffer[0] = chunk.subarray(dropCount);
    pcmCount -= dropCount;
    dropCount = 0;
  }
}

function mergeChunkText(currentText: string, nextText: string): string {
  const next = nextText.trim();
  if (!next) {
    return currentText;
  }
  if (!currentText) {
    return next;
  }

  const currentWords = currentText.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const maxOverlap = Math.min(currentWords.length, nextWords.length, 20);
  let overlapCount = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    let match = true;
    for (let idx = 0; idx < size; idx += 1) {
      const left = normalizeMergeToken(currentWords[currentWords.length - size + idx]);
      const right = normalizeMergeToken(nextWords[idx]);
      if (left !== right) {
        match = false;
        break;
      }
    }

    if (match) {
      overlapCount = size;
      break;
    }
  }

  const suffix = nextWords.slice(overlapCount).join(" ");
  return suffix ? `${currentText} ${suffix}` : currentText;
}

function normalizeMergeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\w]+|[^\w]+$/g, "")
    .trim();
}

function queueChunk(samples: Float32Array): Promise<void> {
  if (isSilentChunk(samples)) {
    silentChunkSkips += 1;
    if (silentChunkSkips === 1 || silentChunkSkips % 10 === 0) {
      debugMetric("chunk-silent-skip", {
        count: silentChunkSkips,
        chunkSecs: roundMetric(samples.length / SAMPLE_RATE),
      });
    }
    return chunkTask;
  }

  const metricId = ++metricChunkId;
  const queuedAt = performance.now();
  queuedChunkCount += 1;
  debugMetric("chunk-queued", {
    id: metricId,
    queueDepth: queuedChunkCount,
    chunkSecs: roundMetric(samples.length / SAMPLE_RATE),
  });

  chunkTask = chunkTask
    .catch(() => undefined)
    .then(async () => {
      queuedChunkCount = Math.max(queuedChunkCount - 1, 0);
      activeChunkCount += 1;
      const queueWaitMs = performance.now() - queuedAt;
      try {
        await processChunk(samples, metricId, queueWaitMs);
      } finally {
        activeChunkCount = Math.max(activeChunkCount - 1, 0);
      }
    });
  return chunkTask;
}

function isSilentChunk(samples: Float32Array): boolean {
  if (samples.length === 0) {
    return true;
  }

  let peak = 0;
  let power = 0;
  for (let idx = 0; idx < samples.length; idx += 1) {
    const value = samples[idx];
    const absValue = Math.abs(value);
    if (absValue > peak) {
      peak = absValue;
    }
    power += value * value;
  }

  const rms = Math.sqrt(power / samples.length);
  return rms < SILENCE_RMS && peak < SILENCE_PEAK;
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

async function processChunk(
  samples: Float32Array,
  metricId = -1,
  queueWaitMs = 0,
): Promise<void> {
  if (!ready) {
    debugMetric("chunk-dropped-unready", { chunkSecs: roundMetric(samples.length / SAMPLE_RATE) });
    return;
  }

  const inferStartedAt = performance.now();
  chunkIdx += 1;
  setStatus(`Processing chunk ${chunkIdx}...`);

  try {
    const text = await requestChunk(samples);
    const mergedText = mergeChunkText(transcriptText, text);
    if (mergedText !== transcriptText) {
      transcriptText = mergedText;
      transcriptEl.textContent = transcriptText;
    }

    if (isRecording) {
      setStatus("Recording...");
    }
    debugMetric("chunk-complete", {
      id: metricId,
      chunkIdx,
      queueWaitMs: roundMetric(queueWaitMs),
      inferMs: roundMetric(performance.now() - inferStartedAt),
      queueDepth: queuedChunkCount,
      active: activeChunkCount,
      textChars: text.length,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setStatus(`Inference error: ${msg}`);
    debugMetric("chunk-error", {
      id: metricId,
      chunkIdx,
      queueWaitMs: roundMetric(queueWaitMs),
      inferMs: roundMetric(performance.now() - inferStartedAt),
      queueDepth: queuedChunkCount,
      active: activeChunkCount,
      message: msg,
    });
  }

  if (pcmCount >= CHUNK_SAMPLES) {
    const next = takeChunkWindow();
    void queueChunk(next);
  }
}

function debugMetric(event: string, values: Record<string, number | string>): void {
  if (!DEBUG_METRICS) {
    return;
  }
  console.debug(`[asr-metrics] ${event}`, values);
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function isDebugMetricsEnabled(): boolean {
  try {
    return window.localStorage.getItem("toru.debug.metrics") !== "0";
  } catch {
    return true;
  }
}
