import { AudioCapture } from "./audio/capture";
import { DictationController } from "./app/dictation-controller";
import { SessionBundleService } from "./app/session-bundles";
import {
  createPluginPlatform,
  formatPluginSummary,
  formatTransformStatus,
  type PluginPlatform,
  type PluginPlatformState,
} from "./plugins";
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
const ortDir = new URL("ort/", appBase).href;

let pluginPlatform: PluginPlatform;
let pluginState: PluginPlatformState | null = null;
let dictation: DictationController;
let sessionBundles: SessionBundleService;

let statusEl: HTMLElement;
let transcriptEl: HTMLElement;
let pluginSummaryEl: HTMLElement;
let transformServiceStatusEl: HTMLElement;
let transformOutputEl: HTMLElement;
let loadBtn: HTMLButtonElement;
let recordBtn: HTMLButtonElement;
let settingsBtn: HTMLButtonElement;
let importPluginBtn: HTMLButtonElement;
let toggleTransformBtn: HTMLButtonElement;
let runTransformBtn: HTMLButtonElement;
let transformInputEl: HTMLTextAreaElement;
let navBtns: HTMLButtonElement[] = [];
let currentRoute: RouteName | null = null;
let screenEls: Record<RouteName, HTMLElement>;
let lastMainRoute: TabRoute = DEFAULT_ROUTE;
let splashEl: HTMLElement;
let splashHideTimer: number | null = null;

window.addEventListener("DOMContentLoaded", () => {
  statusEl = mustEl("status");
  transcriptEl = mustEl("transcript");
  pluginSummaryEl = mustEl("pluginSummary");
  transformServiceStatusEl = mustEl("transformServiceStatus");
  transformOutputEl = mustEl("transformOutput");
  loadBtn = mustBtn("loadBtn");
  recordBtn = mustBtn("recordBtn");
  settingsBtn = mustBtn("settingsBtn");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleTransformBtn = mustBtn("toggleTransformBtn");
  runTransformBtn = mustBtn("runTransformBtn");
  transformInputEl = mustTextarea("transformInput");
  splashEl = mustEl("screen-splash");
  screenEls = {
    transcription: mustEl("screen-transcription"),
    list: mustEl("screen-list"),
    settings: mustEl("screen-settings"),
  };
  navBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".nav-btn[data-route]"),
  );

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
  importPluginBtn.addEventListener("click", () => {
    void importPlugin();
  });
  toggleTransformBtn.addEventListener("click", () => {
    void toggleTransformService();
  });
  runTransformBtn.addEventListener("click", () => {
    void runTransformTest();
  });

  window.addEventListener("beforeunload", () => {
    clearSplashHideTimer();
    void dictation.shutdown();
    void pluginPlatform.shutdown();
  });

  pluginPlatform = createPluginPlatform({
    workerUrl: new URL("./asr.worker.ts", import.meta.url),
    assetBaseUrl: appBase.href,
    ortDir,
    asrEvents: {
      onStatus: (message) => setStatus(message),
      onCrash: (message) => {
        dictation.handleAsrCrash(message);
        resetCrashUi();
      },
    },
  });
  dictation = new DictationController({
    pluginPlatform,
    capture,
    sampleRate: SAMPLE_RATE,
    chunkSecs: CHUNK_SECS,
    strideSecs: STRIDE_SECS,
    silenceRms: SILENCE_RMS,
    silencePeak: SILENCE_PEAK,
    debugMetrics: DEBUG_METRICS,
    onStatus: (message) => setStatus(message),
    onTranscript: (text) => {
      transcriptEl.textContent = text;
    },
    onRecordingChange: (recording) => syncRecordingUi(recording),
    onSessionComplete: (transcript) => persistTranscriptBundle(transcript),
  });
  sessionBundles = new SessionBundleService(getSessionStore());

  void initializePlugins().then(() => loadModel());
  void initializeStorage();
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
  if (route === currentRoute) {
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

  const active = screenEls[route];
  active.classList.remove("fade-in");
  void active.offsetWidth;
  active.classList.add("fade-in");

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

async function persistTranscriptBundle(transcript: string): Promise<void> {
  await sessionBundles.saveTranscriptSession(transcript);
}

async function initializePlugins(): Promise<void> {
  pluginState = await pluginPlatform.init();
  renderPluginStatus();
  if (pluginState.features.transcription) {
    if (!pluginPlatform.isAsrReady()) {
      loadBtn.disabled = false;
    }
  } else {
    loadBtn.disabled = true;
    recordBtn.disabled = true;
  }
  if (pluginState.error) {
    setStatus(`Plugin init failed: ${pluginState.error}`);
  }
}

function updateTransformControls(): void {
  const hasProvider = Boolean(pluginState?.features.transform);
  const canImport = pluginState?.canImport ?? false;
  const running = pluginState?.transformRunning ?? false;
  importPluginBtn.disabled = !canImport;
  toggleTransformBtn.disabled = !hasProvider;
  runTransformBtn.disabled = !hasProvider || !running;
  toggleTransformBtn.textContent = running
    ? "Stop Transform Service"
    : "Start Transform Service";
}

function renderPluginStatus(): void {
  if (!pluginState) {
    pluginSummaryEl.textContent = "Plugin registry loading...";
    transformServiceStatusEl.textContent = "Transform service: unavailable";
    updateTransformControls();
    return;
  }
  pluginSummaryEl.textContent = formatPluginSummary(pluginState);
  transformServiceStatusEl.textContent = formatTransformStatus(pluginState);
  updateTransformControls();
}

async function importPlugin(): Promise<void> {
  if (!pluginState?.canImport) {
    setStatus("Import unavailable outside desktop runtime");
    return;
  }

  importPluginBtn.disabled = true;
  setStatus("Importing plugin...");
  try {
    const sourcePath = await pluginPlatform.pickImportPath();
    if (!sourcePath) {
      return;
    }

    const displayName = window.prompt(
      "Optional display name for this model (leave blank to use filename):",
      "",
    );

    const imported = await pluginPlatform.importFromPath({
      sourcePath,
      displayName: displayName?.trim() || undefined,
    });
    setStatus(`Imported plugin: ${imported.name}`);
    await initializePlugins();
    if (pluginState?.features.transcription && !pluginPlatform.isAsrReady()) {
      void loadModel();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Import failed: ${message}`);
  } finally {
    importPluginBtn.disabled = false;
    updateTransformControls();
  }
}

async function toggleTransformService(): Promise<void> {
  if (!pluginState?.activeTransform) {
    return;
  }

  toggleTransformBtn.disabled = true;
  try {
    const running = !(pluginState?.transformRunning ?? false);
    pluginState = await pluginPlatform.setTransformServiceRunning(running);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transformServiceStatusEl.textContent = `Transform service: ${message}`;
  } finally {
    pluginState = await pluginPlatform.status();
    renderPluginStatus();
  }
}

async function runTransformTest(): Promise<void> {
  if (!pluginState?.activeTransform) {
    transformOutputEl.textContent = "(No active transform provider)";
    return;
  }
  if (!pluginState.transformRunning) {
    transformOutputEl.textContent = "(Start the transform service first)";
    return;
  }

  const input = transformInputEl.value.trim();
  if (!input) {
    transformOutputEl.textContent = "(Enter text to transform)";
    return;
  }

  runTransformBtn.disabled = true;
  transformOutputEl.textContent = "Running transform...";
  try {
    const text = await pluginPlatform.runTransform(input);
    transformOutputEl.textContent = text || "(No output returned)";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transformOutputEl.textContent = `Transform failed: ${message}`;
  } finally {
    pluginState = await pluginPlatform.status();
    renderPluginStatus();
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

function mustTextarea(id: string): HTMLTextAreaElement {
  const el = mustEl(id);
  if (!(el instanceof HTMLTextAreaElement)) {
    throw new Error(`#${id} is not a textarea`);
  }
  return el;
}

function setStatus(message: string): void {
  statusEl.textContent = `Status: ${message}`;
}

function resetCrashUi(): void {
  maybeExitSplash();
  loadBtn.disabled = false;
  recordBtn.disabled = true;
  syncRecordingUi(false);
}

async function loadModel(): Promise<void> {
  if (pluginPlatform.isAsrReady()) {
    setStatus("Model already loaded");
    return;
  }

  pluginState = await pluginPlatform.status();
  renderPluginStatus();
  if (!pluginState.features.transcription) {
    setStatus("No ASR provider available. Import one in Settings.");
    recordBtn.disabled = true;
    loadBtn.disabled = true;
    maybeExitSplash();
    return;
  }

  loadBtn.disabled = true;
  await dictation.loadModel();
  pluginState = await pluginPlatform.status();
  renderPluginStatus();
  recordBtn.disabled = !dictation.isAsrReady();
  loadBtn.disabled = dictation.isAsrReady();
  maybeExitSplash();
}

async function toggleRecording(): Promise<void> {
  if (!dictation.isAsrReady()) {
    void loadModel();
    return;
  }

  recordBtn.disabled = true;
  try {
    await dictation.toggleRecording();
  } finally {
    recordBtn.disabled = !dictation.isAsrReady();
  }
}

function syncRecordingUi(recording: boolean): void {
  recordBtn.textContent = recording ? "Stop" : "Record";
  recordBtn.classList.toggle("recording", recording);
}

function isDebugMetricsEnabled(): boolean {
  try {
    return window.localStorage.getItem("toru.debug.metrics") === "1";
  } catch {
    return false;
  }
}
