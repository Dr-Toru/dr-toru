import { AudioCapture } from "./audio/capture";
import { DictationController } from "./app/dictation-controller";
import { LlmController } from "./app/llm-controller";
import { RecordingService } from "./app/recording-service";
import {
  createPluginPlatform,
  formatPluginSummary,
  formatLlmStatus,
  type PluginPlatform,
  type PluginPlatformState,
} from "./plugins";
import { getRecordingStore } from "./storage";

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
let llm: LlmController;
let recordingService: RecordingService;

let statusEl: HTMLElement;
let transcriptEl: HTMLElement;
let pluginSummaryEl: HTMLElement;
let llmStatusEl: HTMLElement;
let llmOutputEl: HTMLElement;
let loadBtn: HTMLButtonElement;
let recordBtn: HTMLButtonElement;
let settingsBtn: HTMLButtonElement;
let importPluginBtn: HTMLButtonElement;
let toggleLlmBtn: HTMLButtonElement;
let runLlmBtn: HTMLButtonElement;
let llmInputEl: HTMLTextAreaElement;
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
  llmStatusEl = mustEl("llmServiceStatus");
  llmOutputEl = mustEl("llmOutput");
  loadBtn = mustBtn("loadBtn");
  recordBtn = mustBtn("recordBtn");
  settingsBtn = mustBtn("settingsBtn");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleLlmBtn = mustBtn("toggleLlmBtn");
  runLlmBtn = mustBtn("runLlmBtn");
  llmInputEl = mustTextarea("llmInput");
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
  toggleLlmBtn.addEventListener("click", () => {
    void toggleLlmService();
  });
  runLlmBtn.addEventListener("click", () => {
    void runLlmTest();
  });

  window.addEventListener("beforeunload", () => {
    clearSplashHideTimer();
    void dictation.shutdown();
    void pluginPlatform.shutdown();
  });

  pluginPlatform = createPluginPlatform({
    workerUrl: new URL("./asr.worker.ts", import.meta.url),
    ortDir,
    appOrigin: appBase.href,
    asrEvents: {
      onStatus: (message) => setStatus(message),
      onCrash: (message) => {
        dictation.handleAsrCrash(message);
        resetCrashUi();
      },
    },
  });
  llm = new LlmController({
    pluginPlatform,
    onStatus: (message) => {
      llmStatusEl.textContent = message;
    },
    onOutput: (text) => {
      llmOutputEl.textContent = text;
    },
    onStateChange: (state) => {
      pluginState = state;
      renderPluginStatus();
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
    onRecordingComplete: (transcript) => persistTranscript(transcript),
  });
  recordingService = new RecordingService(getRecordingStore());

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
    await getRecordingStore().init();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Storage init failed:", message);
  }
}

async function persistTranscript(transcript: string): Promise<void> {
  await recordingService.persistTranscript(transcript);
}

async function initializePlugins(): Promise<void> {
  pluginState = await pluginPlatform.init();
  llm.setState(pluginState);
  renderPluginStatus();
  if (pluginState.error) {
    setStatus(`Plugin init failed: ${pluginState.error}`);
  }
}

function updateLlmControls(): void {
  const hasProvider = Boolean(pluginState?.features.llm);
  const canImport = pluginState?.canImport ?? false;
  const running = pluginState?.llmRunning ?? false;
  importPluginBtn.disabled = !canImport;
  toggleLlmBtn.disabled = !hasProvider;
  runLlmBtn.disabled = !hasProvider || !running;
  toggleLlmBtn.textContent = running ? "Stop LLM Service" : "Start LLM Service";
}

function renderPluginStatus(): void {
  if (!pluginState) {
    pluginSummaryEl.textContent = "Plugin registry loading...";
    llmStatusEl.textContent = "LLM service: unavailable";
    updateLlmControls();
    return;
  }
  pluginSummaryEl.textContent = formatPluginSummary(pluginState);
  llmStatusEl.textContent = formatLlmStatus(pluginState);
  updateLlmControls();
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
    updateLlmControls();
  }
}

async function toggleLlmService(): Promise<void> {
  if (!llm.isReady()) {
    return;
  }

  toggleLlmBtn.disabled = true;
  try {
    pluginState = await llm.setServiceRunning(!llm.isRunning());
  } finally {
    renderPluginStatus();
  }
}

async function runLlmTest(): Promise<void> {
  runLlmBtn.disabled = true;
  try {
    await llm.run(llmInputEl.value);
  } finally {
    runLlmBtn.disabled = false;
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

  if (!pluginState?.features.transcription) {
    if (!pluginState?.error) {
      setStatus("No ASR provider available. Import one in Settings.");
    }
    recordBtn.disabled = true;
    loadBtn.disabled = true;
    maybeExitSplash();
    return;
  }

  loadBtn.disabled = true;
  const loaded = await dictation.loadModel();
  pluginState = await pluginPlatform.status();
  llm.setState(pluginState);
  renderPluginStatus();
  recordBtn.disabled = !loaded;
  loadBtn.disabled = loaded;
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
