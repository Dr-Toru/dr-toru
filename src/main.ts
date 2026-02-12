import { AsrClient } from "./asr/client";
import { AudioCapture, isSilent } from "./audio/capture";
import { asrQueue } from "./runtime/queues";
import { getSessionStore } from "./storage";

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

const capture = new AudioCapture({
  sampleRate: SAMPLE_RATE,
  chunkSamples: CHUNK_SAMPLES,
  stepSamples: CHUNK_STEP_SAMPLES,
});
const appBase = new URL("./", window.location.href);
const modelsDir = new URL("models/", appBase).href;
const ortDir = new URL("ort/", appBase).href;

let asr: AsrClient;
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

let chunkIdx = 0;
let transcriptText = "";
let metricChunkId = 0;
let silentChunkSkips = 0;

window.addEventListener("DOMContentLoaded", () => {
  statusEl = mustEl("status");
  transcriptEl = mustEl("transcript");
  loadBtn = mustBtn("loadBtn");
  recordBtn = mustBtn("recordBtn");
  settingsBtn = mustBtn("settingsBtn");
  splashEl = mustEl("screen-splash");

  asr = new AsrClient(
    new URL("./asr.worker.ts", import.meta.url),
    {
      onStatus: (message) => setStatus(message),
      onCrash: (message) => handleAsrCrash(message),
    },
  );
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
    void capture.stop();
    asr.terminate();
  });

  void initializeStorage();
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


async function initializeStorage(): Promise<void> {
  try {
    await getSessionStore().init();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Storage init failed:", message);
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

function handleAsrCrash(message: string): void {
  setStatus(`Worker error: ${message}`);
  maybeExitSplash();
  isRecording = false;
  loadBtn.disabled = false;
  recordBtn.disabled = true;
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  void capture.stop();
}

async function loadModel(): Promise<void> {
  if (asr.ready) {
    setStatus("Model already loaded");
    return;
  }

  loadBtn.disabled = true;
  setStatus("Loading model in background...");

  try {
    await asr.load(modelsDir, ortDir);
    setStatus("Model loaded. Ready to record.");
    transcriptEl.textContent = 'Model loaded. Click "Record" to start.';
    recordBtn.disabled = false;
    loadBtn.disabled = true;
    maybeExitSplash();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setStatus(`Load failed: ${msg}`);
    recordBtn.disabled = true;
    loadBtn.disabled = false;
    maybeExitSplash();
  }
}

async function toggleRecording(): Promise<void> {
  if (toggling) {
    return;
  }

  toggling = true;
  recordBtn.disabled = true;

  try {
    if (!asr.ready) {
      setStatus("Model still loading in background...");
      void loadModel();
      return;
    }

    if (!isRecording) {
      try {
        chunkIdx = 0;
        transcriptText = "";
        metricChunkId = 0;
        silentChunkSkips = 0;
        debugMetric("session-start", { chunkSecs: CHUNK_SECS, strideSecs: STRIDE_SECS });

        await capture.start((chunk) => void queueChunk(chunk));

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
    await capture.stop();

    recordBtn.textContent = "Record";
    recordBtn.classList.remove("recording");

    const tail = capture.drain();
    if (tail) {
      void queueChunk(tail);
    }

    await waitForChunks();

    if (!transcriptText) {
      transcriptEl.textContent = "(No speech detected)";
    }
    setStatus("Done");
  } finally {
    toggling = false;
    recordBtn.disabled = !asr.ready;
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
  if (isSilent(samples, SILENCE_RMS, SILENCE_PEAK)) {
    silentChunkSkips += 1;
    if (silentChunkSkips === 1 || silentChunkSkips % 10 === 0) {
      debugMetric("chunk-silent-skip", {
        count: silentChunkSkips,
        chunkSecs: roundMetric(samples.length / SAMPLE_RATE),
      });
    }
    return asrQueue.waitForIdle();
  }

  const metricId = ++metricChunkId;
  const queuedAt = performance.now();

  const task = asrQueue.enqueue(async () => {
    const queueWaitMs = performance.now() - queuedAt;
    await processChunk(samples, metricId, queueWaitMs);
  });

  debugMetric("chunk-queued", {
    id: metricId,
    queueDepth: asrQueue.pendingCount,
    chunkSecs: roundMetric(samples.length / SAMPLE_RATE),
  });
  return task;
}

async function waitForChunks(): Promise<void> {
  await asrQueue.waitForIdle();
}

async function processChunk(
  samples: Float32Array,
  metricId = -1,
  queueWaitMs = 0,
): Promise<void> {
  if (!asr.ready) {
    debugMetric("chunk-dropped-unready", { chunkSecs: roundMetric(samples.length / SAMPLE_RATE) });
    return;
  }

  const inferStartedAt = performance.now();
  chunkIdx += 1;
  setStatus(`Processing chunk ${chunkIdx}...`);

  try {
    const text = await asr.transcribe(samples);
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
      queueDepth: asrQueue.pendingCount,
      active: asrQueue.activeCount,
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
      queueDepth: asrQueue.pendingCount,
      active: asrQueue.activeCount,
      message: msg,
    });
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
    return window.localStorage.getItem("toru.debug.metrics") === "1";
  } catch {
    return false;
  }
}
