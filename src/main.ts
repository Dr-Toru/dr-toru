import { invoke } from "@tauri-apps/api/core";

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
import {
  createPluginPlatform,
  formatLlmStatus,
  formatPluginSummary,
  type PluginPlatform,
  type PluginPlatformState,
} from "./plugins";
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
let settingsBtn: HTMLButtonElement;
let importPluginBtn: HTMLButtonElement;
let toggleLlmBtn: HTMLButtonElement;
let runLlmBtn: HTMLButtonElement;
let toggleDevtoolsBtn: HTMLButtonElement;
let llmInputEl: HTMLTextAreaElement;
let saveAsrSettingsBtn: HTMLButtonElement;
let asrSettingsStatusEl: HTMLElement;
let devtoolsStatusEl: HTMLElement;
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
let devtoolsBusy = false;
let devtoolsStatusError: string | null = null;
let devtoolsState: DevtoolsState = {
  available: false,
  open: false,
};

interface DevtoolsState {
  available: boolean;
  open: boolean;
}

window.addEventListener("DOMContentLoaded", () => {
  pluginSummaryEl = mustEl("pluginSummary");
  llmStatusEl = mustEl("llmServiceStatus");
  llmOutputEl = mustEl("llmOutput");
  appErrorEl = mustEl("appError");
  asrLoadingEl = mustEl("asrLoading");
  beamLoadingEl = mustEl("beamLoading");
  settingsBtn = mustBtn("settingsBtn");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleLlmBtn = mustBtn("toggleLlmBtn");
  runLlmBtn = mustBtn("runLlmBtn");
  toggleDevtoolsBtn = mustBtn("toggleDevtoolsBtn");
  saveAsrSettingsBtn = mustBtn("saveAsrSettingsBtn");
  llmInputEl = mustTextarea("llmInput");
  asrSettingsStatusEl = mustEl("asrSettingsStatus");
  devtoolsStatusEl = mustEl("devtoolsStatus");
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

  const barEls = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#screen-recording .status-indicator .bar",
    ),
  );

  recordingView = new RecordingViewController({
    transcriptEl: mustEl("transcript"),
    contextNoteEl: mustTextarea("contextNote"),
    transcribeBtn: mustBtn("recordBtn"),
    timerEl: mustEl("recordingTimer"),
    barEls,
    typingIndicatorEl: mustEl("typingIndicator"),
    recordingService,
    onToggleRecording: () => toggleRecording(),
    onRecordingsChanged: () => fireRecordingsChanged(),
    onError: (error, context) => reportUnexpectedError(error, context),
  });

  mustBtn("blankRecordBtn").addEventListener("click", () => {
    void toggleRecording();
  });

  const copyBtn = mustBtn("copyTranscriptBtn");
  copyBtn.addEventListener("click", () => {
    const transcriptEl = mustEl("transcript");
    const text = transcriptEl.textContent?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("copied");
      }, 1500);
    });
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
  toggleDevtoolsBtn.addEventListener("click", () => {
    void toggleDevtools();
  });
  renderDevtoolsControls();
  void refreshDevtoolsState();

  window.addEventListener("error", (event) => {
    reportUnexpectedError(event.error ?? event.message, "Runtime error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    reportUnexpectedError(event.reason, "Unhandled async error");
  });

  window.addEventListener("beforeunload", () => {
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
      },
      onCrash: (message) => {
        asrLoadPhase = "idle";
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
    onLevel: (rms) => recordingView.setLevel(rms),
    onRecordingChange: (recording) => recordingView.setRecording(recording),
    onRecordingComplete: (transcript) =>
      recordingView.onRecordingComplete(transcript),
  });

  void initializeStorage();
  void setRoute(parseRoute(window.location.hash), true);
  void initializePlugins().catch((error) =>
    reportUnexpectedError(error, "Startup failed"),
  );
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

    // Tear down the ASR worker when leaving the recording screen so
    // its WASM heap is returned to the OS. The model binary is in the
    // Cache API, so reloading on return is fast.
    if (currentRoute?.name === "recording" && nextRoute.name !== "recording") {
      void pluginPlatform.unloadAsr();
    }

    currentRoute = nextRoute;
    currentRouteStateKey = key;

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
      void refreshDevtoolsState();
    } else if (nextRoute.name === "recording" && asrSettings.asrEnabled) {
      void loadModel();
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
    if (currentRoute?.name === "recording" && asrSettings.asrEnabled) {
      void loadModel();
    }
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
    if (
      imported.kind === "asr" &&
      asrSettings.asrEnabled &&
      currentRoute?.name === "recording"
    ) {
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

function renderDevtoolsControls(): void {
  const open = devtoolsState.open;
  toggleDevtoolsBtn.textContent = open ? "Close DevTools" : "Open DevTools";
  toggleDevtoolsBtn.disabled = devtoolsBusy || !devtoolsState.available;

  if (devtoolsStatusError) {
    devtoolsStatusEl.textContent = devtoolsStatusError;
    return;
  }

  if (devtoolsBusy) {
    devtoolsStatusEl.textContent = "Updating DevTools state...";
    return;
  }

  if (!devtoolsState.available) {
    devtoolsStatusEl.textContent =
      "DevTools toggle is only available in desktop debug builds.";
    return;
  }

  devtoolsStatusEl.textContent = open
    ? "DevTools is open."
    : "DevTools is closed.";
}

async function refreshDevtoolsState(): Promise<void> {
  devtoolsBusy = true;
  renderDevtoolsControls();
  try {
    devtoolsState = await invoke<DevtoolsState>("debug_devtools_status");
    devtoolsStatusError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devtoolsState = { available: false, open: false };
    devtoolsStatusError = `DevTools toggle unavailable: ${message}`;
  } finally {
    devtoolsBusy = false;
    renderDevtoolsControls();
  }
}

async function toggleDevtools(): Promise<void> {
  if (devtoolsBusy || !devtoolsState.available) {
    return;
  }

  const nextOpen = !devtoolsState.open;
  devtoolsBusy = true;
  renderDevtoolsControls();
  try {
    devtoolsState = await invoke<DevtoolsState>("debug_devtools_set", {
      open: nextOpen,
    });
    devtoolsStatusError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devtoolsStatusError = `Failed to toggle DevTools: ${message}`;
  } finally {
    devtoolsBusy = false;
    renderDevtoolsControls();
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
  showAppError(`${context}: ${message}`);
}

function showAppError(message: string): void {
  appErrorEl.textContent = message;
  appErrorEl.hidden = false;
}

function updateAsrLoadPhaseFromStatus(message: string): void {
  const normalized = message.toLowerCase();
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
