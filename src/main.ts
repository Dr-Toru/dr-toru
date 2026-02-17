import { AudioCapture } from "./audio/capture";
import {
  readAsrSettings,
  sanitizeAsrSettings,
  writeAsrSettings,
  type AsrSettings,
} from "./asr/settings";
import { DictationController } from "./app/dictation-controller";
import { ListController, fireRecordingsChanged } from "./app/list";
import { LlmController } from "./app/llm-controller";
import { RecordingService } from "./app/recording-service";
import { RecordingViewController } from "./app/recording-view-controller";
import {
  isTabRouteName,
  parseRoute,
  routeKey,
  routeToHash,
  type AppRoute,
  type RouteName,
} from "./app/router";
import { SessionDiagnostics } from "./app/session-diagnostics";
import {
  createPluginPlatform,
  formatLlmStatus,
  formatPluginSummary,
  type PluginPlatform,
  type PluginPlatformState,
} from "./plugins";
import { asrQueue } from "./runtime/queues";
import { getRecordingStore } from "./storage";

const SAMPLE_RATE = 16000;
const DEBUG_METRICS = isDebugMetricsEnabled();
let asrSettings = loadAsrSettings();

const capture = new AudioCapture({
  sampleRate: SAMPLE_RATE,
  chunkSamples: chunkSamplesFor(asrSettings.chunkSecs),
  stepSamples: chunkStepSamplesFor(
    asrSettings.chunkSecs,
    asrSettings.strideSecs,
  ),
});
const appBase = new URL("./", window.location.href);
const ortDir = new URL("ort/", appBase).href;

let pluginPlatform: PluginPlatform;
let pluginState: PluginPlatformState | null = null;
let dictation: DictationController;
let llm: LlmController;
let recordingView: RecordingViewController;
let listController: ListController;

let pluginSummaryEl: HTMLElement;
let llmStatusEl: HTMLElement;
let llmOutputEl: HTMLElement;
let appErrorEl: HTMLElement;
let asrLoadingEl: HTMLElement;
let beamLoadingEl: HTMLElement;
let diagnosticsSummaryEl: HTMLElement;
let diagnosticsOutputEl: HTMLElement;
let settingsBtn: HTMLButtonElement;
let importPluginBtn: HTMLButtonElement;
let toggleLlmBtn: HTMLButtonElement;
let runLlmBtn: HTMLButtonElement;
let refreshDiagnosticsBtn: HTMLButtonElement;
let clearDiagnosticsBtn: HTMLButtonElement;
let llmInputEl: HTMLTextAreaElement;
let saveAsrSettingsBtn: HTMLButtonElement;
let asrSettingsStatusEl: HTMLElement;
let asrEnabledInput: HTMLInputElement;
let asrBeamSearchEnabledInput: HTMLInputElement;
let asrChunkSecsInput: HTMLInputElement;
let asrStrideSecsInput: HTMLInputElement;
let asrSilenceRmsInput: HTMLInputElement;
let asrSilencePeakInput: HTMLInputElement;
let asrSilenceHoldInput: HTMLInputElement;
let asrSilenceProbeInput: HTMLInputElement;
let asrOrtThreadsInput: HTMLInputElement;
let asrBeamWidthInput: HTMLInputElement;
let asrLmAlphaInput: HTMLInputElement;
let asrLmBetaInput: HTMLInputElement;
let asrMinTokenLogpInput: HTMLInputElement;
let asrBeamPruneLogpInput: HTMLInputElement;
let navBtns: HTMLButtonElement[] = [];
let screenEls: Record<RouteName, HTMLElement>;
let currentRoute: AppRoute | null = null;
let currentRouteStateKey = "";
let lastMainRoute: AppRoute = { name: "list" };
let routeSeq = 0;
let asrLoadTask: Promise<boolean> | null = null;
let asrLoadPhase: "idle" | "asr" | "beam" = "idle";
let diagnostics: SessionDiagnostics | null = null;

window.addEventListener("DOMContentLoaded", () => {
  pluginSummaryEl = mustEl("pluginSummary");
  llmStatusEl = mustEl("llmServiceStatus");
  llmOutputEl = mustEl("llmOutput");
  appErrorEl = mustEl("appError");
  asrLoadingEl = mustEl("asrLoading");
  beamLoadingEl = mustEl("beamLoading");
  diagnosticsSummaryEl = mustEl("diagnosticsSummary");
  diagnosticsOutputEl = mustEl("diagnosticsOutput");
  settingsBtn = mustBtn("settingsBtn");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleLlmBtn = mustBtn("toggleLlmBtn");
  runLlmBtn = mustBtn("runLlmBtn");
  refreshDiagnosticsBtn = mustBtn("refreshDiagnosticsBtn");
  clearDiagnosticsBtn = mustBtn("clearDiagnosticsBtn");
  saveAsrSettingsBtn = mustBtn("saveAsrSettingsBtn");
  llmInputEl = mustTextarea("llmInput");
  asrSettingsStatusEl = mustEl("asrSettingsStatus");
  asrEnabledInput = mustInput("asrEnabled");
  asrBeamSearchEnabledInput = mustInput("asrBeamSearchEnabled");
  asrChunkSecsInput = mustInput("asrChunkSecs");
  asrStrideSecsInput = mustInput("asrStrideSecs");
  asrSilenceRmsInput = mustInput("asrSilenceRms");
  asrSilencePeakInput = mustInput("asrSilencePeak");
  asrSilenceHoldInput = mustInput("asrSilenceHoldChunks");
  asrSilenceProbeInput = mustInput("asrSilenceProbeEvery");
  asrOrtThreadsInput = mustInput("asrOrtThreads");
  asrBeamWidthInput = mustInput("asrBeamWidth");
  asrLmAlphaInput = mustInput("asrLmAlpha");
  asrLmBetaInput = mustInput("asrLmBeta");
  asrMinTokenLogpInput = mustInput("asrMinTokenLogp");
  asrBeamPruneLogpInput = mustInput("asrBeamPruneLogp");
  asrEnabledInput.addEventListener("change", () => {
    updateAsrSettingsFieldState();
  });
  asrBeamSearchEnabledInput.addEventListener("change", () => {
    updateAsrSettingsFieldState();
  });
  renderAsrSettingsForm(asrSettings);
  screenEls = {
    recording: mustEl("screen-recording"),
    list: mustEl("screen-list"),
    settings: mustEl("screen-settings"),
  };

  navBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".nav-btn[data-route]"),
  );

  for (const navBtn of navBtns) {
    navBtn.addEventListener("click", () => {
      const route = navBtn.dataset.route;
      if (!isTabRouteName(route)) {
        return;
      }
      const nextRoute: AppRoute =
        route === "recording"
          ? { name: "recording", recordingId: null }
          : { name: "list" };
      void setRoute(nextRoute, true);
    });
  }

  settingsBtn.addEventListener("click", () => {
    if (currentRoute?.name === "settings") {
      void setRoute(lastMainRoute, true);
      return;
    }
    void setRoute({ name: "settings" }, true);
  });

  const store = getRecordingStore();
  const recordingService = new RecordingService(store);

  recordingView = new RecordingViewController({
    transcriptEl: mustTextarea("transcript"),
    transcribeBtn: mustBtn("recordBtn"),
    recordingService,
    onToggleRecording: () => toggleRecording(),
    onRecordingsChanged: () => fireRecordingsChanged(),
    onError: (error, context) => reportUnexpectedError(error, context),
  });

  listController = new ListController({
    container: mustEl("recording-list"),
    store,
    onSelect: (recordingId) => {
      void setRoute({ name: "recording", recordingId }, true);
    },
  });

  window.addEventListener("hashchange", () => {
    void setRoute(parseRoute(window.location.hash), false);
  });

  importPluginBtn.addEventListener("click", () => {
    void importPlugin().catch((error) =>
      reportUnexpectedError(error, "Plugin import failed"),
    );
  });
  toggleLlmBtn.addEventListener("click", () => {
    void toggleLlmService().catch((error) =>
      reportUnexpectedError(error, "LLM service toggle failed"),
    );
  });
  runLlmBtn.addEventListener("click", () => {
    void runLlmTest().catch((error) =>
      reportUnexpectedError(error, "LLM test failed"),
    );
  });
  saveAsrSettingsBtn.addEventListener("click", () => {
    saveAsrSettings();
  });
  refreshDiagnosticsBtn.addEventListener("click", () => {
    renderDiagnostics();
  });
  clearDiagnosticsBtn.addEventListener("click", () => {
    diagnostics?.clear();
    renderDiagnostics();
  });

  window.addEventListener("error", (event) => {
    diagnostics?.recordEvent("window-error", {
      context: "runtime-error",
      message: String(event.error ?? event.message),
    });
    reportUnexpectedError(event.error ?? event.message, "Runtime error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    diagnostics?.recordEvent("window-error", {
      context: "unhandled-rejection",
      message: String(event.reason),
    });
    reportUnexpectedError(event.reason, "Unhandled async error");
  });

  window.addEventListener("beforeunload", () => {
    diagnostics?.stop(true);
    void dictation.shutdown();
    void pluginPlatform.shutdown();
    listController.unmount();
  });

  pluginPlatform = createPluginPlatform({
    workerUrl: new URL("./asr.worker.ts", import.meta.url),
    ortDir,
    appOrigin: appBase.href,
    asrRuntimeConfig: asrSettings.runtimeConfig,
    asrEvents: {
      onStatus: (message) => {
        updateAsrLoadPhaseFromStatus(message);
        if (
          message.toLowerCase().includes("failed") ||
          message.toLowerCase().includes("unavailable") ||
          message.toLowerCase().includes("error")
        ) {
          diagnostics?.recordEvent("asr-status", { message });
        }
      },
      onCrash: (message) => {
        asrLoadPhase = "idle";
        diagnostics?.recordEvent("asr-crash", { message });
        dictation.handleAsrCrash(message);
        recordingView.setTranscribeAvailable(isAsrTranscriptionEnabled());
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
    chunkSecs: asrSettings.chunkSecs,
    strideSecs: asrSettings.strideSecs,
    silenceRms: asrSettings.silenceRms,
    silencePeak: asrSettings.silencePeak,
    speechHoldChunks: asrSettings.silenceHoldChunks,
    silenceProbeEvery: asrSettings.silenceProbeEvery,
    debugMetrics: DEBUG_METRICS,
    onStatus: () => undefined,
    onTranscript: (text) => {
      recordingView.setLiveTranscript(text);
    },
    onRecordingChange: (recording) => recordingView.setRecording(recording),
    onRecordingComplete: (transcript) =>
      recordingView.onRecordingComplete(transcript),
  });
  diagnostics = new SessionDiagnostics(window.localStorage);
  diagnostics.start(() => collectDiagnosticsBeat());
  const previousUnclean = diagnostics.getPreviousUncleanSummary();
  if (previousUnclean) {
    showAppError(
      `Previous session ended unexpectedly at ${previousUnclean}. Open Settings for diagnostics.`,
    );
  }
  renderDiagnostics();

  void initializeStorage();
  void setRoute(parseRoute(window.location.hash), true);
  void initializePlugins()
    .then(() => {
      if (asrSettings.asrEnabled) {
        void loadModel();
      }
    })
    .catch((error) => reportUnexpectedError(error, "Startup failed"));
});

async function setRoute(route: AppRoute, syncHash: boolean): Promise<void> {
  try {
    if (
      dictation.isRecording &&
      currentRoute?.name === "recording" &&
      route.name !== "recording"
    ) {
      showAppError("Stop recording before leaving the recording view.");
      if (currentRoute) {
        syncRouteHash(currentRoute);
      }
      return;
    }

    const seq = ++routeSeq;
    let nextRoute = route;
    if (route.name !== "recording") {
      const key = routeKey(route);
      if (key === currentRouteStateKey) {
        if (syncHash) {
          syncRouteHash(route);
        }
        return;
      }
    }

    if (route.name === "recording") {
      const opened = await recordingView.openRoute(route.recordingId);
      if (seq !== routeSeq) {
        return;
      }
      if (opened.status === "missing") {
        showAppError(`Recording not found: ${opened.recordingId}`);
        await setRoute({ name: "list" }, true);
        return;
      }
      if (opened.status === "blocked") {
        showAppError("Stop recording before switching recordings.");
        if (currentRoute) {
          syncRouteHash(currentRoute);
        }
        return;
      }
      if (opened.status === "error") {
        return;
      }
      nextRoute = { name: "recording", recordingId: opened.recordingId };
    }

    const key = routeKey(nextRoute);
    if (key === currentRouteStateKey) {
      if (syncHash) {
        syncRouteHash(nextRoute);
      }
      return;
    }

    if (currentRoute?.name === "list" && nextRoute.name !== "list") {
      listController.unmount();
    }

    currentRoute = nextRoute;
    currentRouteStateKey = key;
    diagnostics?.recordEvent("route-change", { route: key });

    if (nextRoute.name === "list") {
      listController.mount();
    }

    for (const name of Object.keys(screenEls) as RouteName[]) {
      const isActive = name === nextRoute.name;
      const screen = screenEls[name];
      screen.hidden = !isActive;
      screen.setAttribute("aria-hidden", String(!isActive));
    }

    const active = screenEls[nextRoute.name];
    active.classList.remove("fade-in");
    void active.offsetWidth;
    active.classList.add("fade-in");

    for (const navBtn of navBtns) {
      const isActive = navBtn.dataset.route === nextRoute.name;
      navBtn.classList.toggle("is-active", isActive);
      if (isActive) {
        navBtn.setAttribute("aria-current", "page");
      } else {
        navBtn.removeAttribute("aria-current");
      }
    }

    const settingsActive = nextRoute.name === "settings";
    settingsBtn.classList.toggle("is-active", settingsActive);
    settingsBtn.setAttribute("aria-pressed", String(settingsActive));

    if (nextRoute.name !== "settings") {
      lastMainRoute = nextRoute;
    }

    if (syncHash) {
      syncRouteHash(nextRoute);
    }
    if (nextRoute.name === "settings") {
      renderDiagnostics();
    }
  } catch (error) {
    reportUnexpectedError(error, "Navigation failed");
  }
}

function syncRouteHash(route: AppRoute): void {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

async function initializeStorage(): Promise<void> {
  try {
    await getRecordingStore().init();
  } catch (error) {
    reportUnexpectedError(error, "Storage init failed");
  }
}

async function initializePlugins(): Promise<void> {
  try {
    pluginState = await pluginPlatform.init();
    llm.setState(pluginState);
    renderPluginStatus();
  } catch (error) {
    reportUnexpectedError(error, "Plugin init failed");
    throw error;
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
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    updateLlmControls();
    return;
  }

  const summary = formatPluginSummary(pluginState);
  pluginSummaryEl.textContent = asrSettings.asrEnabled
    ? summary
    : `${summary} | ASR disabled in settings`;
  llmStatusEl.textContent = formatLlmStatus(pluginState);
  recordingView.setTranscribeAvailable(isAsrTranscriptionEnabled());
  updateAsrLoadingIndicator();
  updateLlmControls();
}

async function importPlugin(): Promise<void> {
  if (!pluginState?.canImport) {
    llmStatusEl.textContent = "Import unavailable outside desktop runtime";
    return;
  }

  importPluginBtn.disabled = true;
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
    llmStatusEl.textContent = `Imported plugin: ${imported.name}`;
    await initializePlugins();
    if (imported.kind === "asr" && asrSettings.asrEnabled) {
      void loadModel();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    llmStatusEl.textContent = `Import failed: ${message}`;
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

function saveAsrSettings(): void {
  if (dictation?.isRecording) {
    asrSettingsStatusEl.textContent =
      "Stop recording before saving ASR settings.";
    return;
  }

  try {
    const nextSettings = sanitizeAsrSettings({
      asrEnabled: asrEnabledInput.checked,
      chunkSecs: asrChunkSecsInput.valueAsNumber,
      strideSecs: asrStrideSecsInput.valueAsNumber,
      silenceRms: asrSilenceRmsInput.valueAsNumber,
      silencePeak: asrSilencePeakInput.valueAsNumber,
      silenceHoldChunks: asrSilenceHoldInput.valueAsNumber,
      silenceProbeEvery: asrSilenceProbeInput.valueAsNumber,
      runtimeConfig: {
        ortThreads: asrOrtThreadsInput.valueAsNumber,
        decode: {
          beamSearchEnabled: asrBeamSearchEnabledInput.checked,
          beamWidth: asrBeamWidthInput.valueAsNumber,
          lmAlpha: asrLmAlphaInput.valueAsNumber,
          lmBeta: asrLmBetaInput.valueAsNumber,
          minTokenLogp: asrMinTokenLogpInput.valueAsNumber,
          beamPruneLogp: asrBeamPruneLogpInput.valueAsNumber,
        },
      },
    });

    writeAsrSettings(nextSettings);
    asrSettings = nextSettings;
    renderAsrSettingsForm(nextSettings);
    asrSettingsStatusEl.textContent =
      "ASR settings saved. Reloading to apply updated runtime settings...";
    window.setTimeout(() => {
      window.location.reload();
    }, 150);
  } catch (error) {
    reportUnexpectedError(error, "Failed to save ASR settings");
  }
}

function renderAsrSettingsForm(settings: AsrSettings): void {
  asrEnabledInput.checked = settings.asrEnabled;
  asrBeamSearchEnabledInput.checked =
    settings.runtimeConfig.decode.beamSearchEnabled;
  asrChunkSecsInput.value = String(settings.chunkSecs);
  asrStrideSecsInput.value = String(settings.strideSecs);
  asrSilenceRmsInput.value = String(settings.silenceRms);
  asrSilencePeakInput.value = String(settings.silencePeak);
  asrSilenceHoldInput.value = String(settings.silenceHoldChunks);
  asrSilenceProbeInput.value = String(settings.silenceProbeEvery);
  asrOrtThreadsInput.value = String(settings.runtimeConfig.ortThreads);
  asrBeamWidthInput.value = String(settings.runtimeConfig.decode.beamWidth);
  asrLmAlphaInput.value = String(settings.runtimeConfig.decode.lmAlpha);
  asrLmBetaInput.value = String(settings.runtimeConfig.decode.lmBeta);
  asrMinTokenLogpInput.value = String(
    settings.runtimeConfig.decode.minTokenLogp,
  );
  asrBeamPruneLogpInput.value = String(
    settings.runtimeConfig.decode.beamPruneLogp,
  );
  updateAsrSettingsFieldState();
  asrSettingsStatusEl.textContent =
    "Tune ASR values here. Saving reloads the app and applies new settings.";
}

function updateAsrSettingsFieldState(): void {
  const asrEnabled = asrEnabledInput.checked;
  const beamEnabled = asrBeamSearchEnabledInput.checked;

  asrBeamSearchEnabledInput.disabled = !asrEnabled;
  asrChunkSecsInput.disabled = !asrEnabled;
  asrStrideSecsInput.disabled = !asrEnabled;
  asrSilenceRmsInput.disabled = !asrEnabled;
  asrSilencePeakInput.disabled = !asrEnabled;
  asrSilenceHoldInput.disabled = !asrEnabled;
  asrSilenceProbeInput.disabled = !asrEnabled;
  asrOrtThreadsInput.disabled = !asrEnabled;

  const decodeEnabled = asrEnabled && beamEnabled;
  asrBeamWidthInput.disabled = !decodeEnabled;
  asrLmAlphaInput.disabled = !decodeEnabled;
  asrLmBetaInput.disabled = !decodeEnabled;
  asrMinTokenLogpInput.disabled = !decodeEnabled;
  asrBeamPruneLogpInput.disabled = !decodeEnabled;
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

function mustInput(id: string): HTMLInputElement {
  const el = mustEl(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return el;
}

function reportUnexpectedError(error: unknown, context: string): void {
  console.error(`${context}:`, error);
  const message = error instanceof Error ? error.message : String(error);
  diagnostics?.recordEvent("app-error", { context, message });
  showAppError(`${context}: ${message}`);
}

function showAppError(message: string): void {
  appErrorEl.textContent = message;
  appErrorEl.hidden = false;
}

function updateAsrLoadPhaseFromStatus(message: string): void {
  const normalized = message.toLowerCase();
  const previousPhase = asrLoadPhase;
  if (normalized.includes("language model")) {
    asrLoadPhase = "beam";
  } else if (
    normalized.includes("vocab") ||
    normalized.includes("onnx") ||
    normalized.includes("inference") ||
    normalized.includes("model")
  ) {
    asrLoadPhase = "asr";
  }
  if (previousPhase !== asrLoadPhase) {
    diagnostics?.recordEvent("asr-load-phase", { phase: asrLoadPhase });
  }
  updateAsrLoadingIndicator();
}

function updateAsrLoadingIndicator(): void {
  const hasTranscription = isAsrTranscriptionEnabled();
  const isReady = hasTranscription && pluginPlatform.isAsrReady();
  const isLoading = asrLoadTask !== null;
  const showLoading = hasTranscription && isLoading && !isReady;

  const showBeamLoading =
    showLoading &&
    asrLoadPhase === "beam" &&
    asrSettings.runtimeConfig.decode.beamSearchEnabled;
  const showAsrLoading = showLoading && !showBeamLoading;

  asrLoadingEl.hidden = !showAsrLoading;
  beamLoadingEl.hidden = !showBeamLoading;
}

async function loadModel(): Promise<boolean> {
  if (!asrSettings.asrEnabled) {
    asrLoadPhase = "idle";
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    return false;
  }

  if (pluginPlatform.isAsrReady()) {
    asrLoadPhase = "idle";
    updateAsrLoadingIndicator();
    return true;
  }

  if (!pluginState?.features.transcription) {
    asrLoadPhase = "idle";
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    return false;
  }

  if (asrLoadTask) {
    return asrLoadTask;
  }

  asrLoadPhase = "asr";
  asrLoadTask = (async () => {
    const loaded = await dictation.loadModel();
    pluginState = await pluginPlatform.status();
    llm.setState(pluginState);
    renderPluginStatus();
    return loaded;
  })()
    .catch((error) => {
      reportUnexpectedError(error, "ASR load failed");
      return false;
    })
    .finally(() => {
      asrLoadTask = null;
      asrLoadPhase = "idle";
      updateAsrLoadingIndicator();
    });

  updateAsrLoadingIndicator();
  return asrLoadTask;
}

async function toggleRecording(): Promise<void> {
  if (!isAsrTranscriptionEnabled()) {
    return;
  }

  if (!dictation.isAsrReady()) {
    const loaded = await loadModel();
    if (!loaded) {
      return;
    }
  }

  await dictation.toggleRecording();
}

function isAsrTranscriptionEnabled(): boolean {
  return asrSettings.asrEnabled && Boolean(pluginState?.features.transcription);
}

function renderDiagnostics(): void {
  if (!diagnostics) {
    diagnosticsSummaryEl.textContent = "Diagnostics unavailable.";
    diagnosticsOutputEl.textContent = "";
    return;
  }
  diagnosticsSummaryEl.textContent = diagnostics.getSummary();
  diagnosticsOutputEl.textContent = diagnostics.getReport(100);
}

function collectDiagnosticsBeat(): Record<string, string | number | boolean> {
  const memory = readHeapMemory();
  return {
    route: currentRouteStateKey || routeKey(parseRoute(window.location.hash)),
    recording: dictation?.isRecording ?? false,
    asrEnabled: asrSettings.asrEnabled,
    beamEnabled: asrSettings.runtimeConfig.decode.beamSearchEnabled,
    asrReady: pluginPlatform?.isAsrReady() ?? false,
    asrLoadPhase,
    queueDepth: asrQueue.depth,
    queuePending: asrQueue.pendingCount,
    queueActive: asrQueue.activeCount,
    captureBufferedSamples: capture.bufferedSamples,
    hasTranscription: isAsrTranscriptionEnabled(),
    heapUsedMb: memory.usedMb,
    heapTotalMb: memory.totalMb,
    heapLimitMb: memory.limitMb,
  };
}

function readHeapMemory(): {
  usedMb: number;
  totalMb: number;
  limitMb: number;
} {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };
  const memory = perf.memory;
  if (!memory) {
    return { usedMb: -1, totalMb: -1, limitMb: -1 };
  }
  return {
    usedMb: roundToOneDecimal(memory.usedJSHeapSize / (1024 * 1024)),
    totalMb: roundToOneDecimal(memory.totalJSHeapSize / (1024 * 1024)),
    limitMb: roundToOneDecimal(memory.jsHeapSizeLimit / (1024 * 1024)),
  };
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function isDebugMetricsEnabled(): boolean {
  try {
    return window.localStorage.getItem("toru.debug.metrics") === "1";
  } catch {
    return false;
  }
}

function loadAsrSettings(): AsrSettings {
  try {
    return readAsrSettings();
  } catch (error) {
    console.error("Failed to read ASR settings from storage:", error);
    return sanitizeAsrSettings(undefined);
  }
}

function chunkSamplesFor(chunkSecs: number): number {
  return Math.floor(chunkSecs * SAMPLE_RATE);
}

function chunkStepSamplesFor(chunkSecs: number, strideSecs: number): number {
  const chunkSamples = chunkSamplesFor(chunkSecs);
  const strideSamples = Math.floor(strideSecs * SAMPLE_RATE);
  return Math.max(Math.floor(0.75 * SAMPLE_RATE), chunkSamples - strideSamples);
}
