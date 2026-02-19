import { decodeAudioFileToSamples } from "./audio/upload";
import { AudioCapture } from "./audio/capture";
import {
  readAsrSettings,
  sanitizeAsrSettings,
  type AsrSettings,
} from "./asr/settings";
import { AsrSettingsController } from "./app/asr-settings-controller";
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
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const DEBUG_METRICS = isDebugMetricsEnabled();
const asrSettings = loadAsrSettings();

const capture = new AudioCapture({ sampleRate: SAMPLE_RATE });
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
let appErrorEl: HTMLElement;
let settingsBtn: HTMLButtonElement;
let uploadTranscriptBtn: HTMLButtonElement;
let transcriptUploadInput: HTMLInputElement;
let pluginListEl: HTMLElement;
let importPluginBtn: HTMLButtonElement;
let toggleLlmBtn: HTMLButtonElement;
let navBtns: HTMLButtonElement[] = [];
let screenEls: Record<RouteName, HTMLElement>;
let currentRoute: AppRoute | null = null;
let currentRouteStateKey = "";
let lastMainRoute: AppRoute = { name: "list" };
let routeSeq = 0;
let asrLoadTask: Promise<boolean> | null = null;

window.addEventListener("DOMContentLoaded", () => {
  pluginSummaryEl = mustEl("pluginSummary");
  llmStatusEl = mustEl("llmServiceStatus");
  appErrorEl = mustEl("appError");
  settingsBtn = mustBtn("settingsBtn");
  uploadTranscriptBtn = mustBtn("uploadTranscriptBtn");
  transcriptUploadInput = mustFileInput("transcriptUploadInput");
  pluginListEl = mustEl("pluginList");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleLlmBtn = mustBtn("toggleLlmBtn");

  const asrSettingsController = new AsrSettingsController({
    isRecording: () => dictation?.isRecording ?? false,
    onError: (error, context) => reportUnexpectedError(error, context),
  });
  asrSettingsController.populate(asrSettings);

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
    headerTranscribeBtn: mustBtn("headerRecordBtn"),
    uploadBtn: uploadTranscriptBtn,
    timerEl: mustEl("recordingTimer"),
    barEls,
    typingIndicatorEl: mustEl("typingIndicator"),
    recordingService,
    onToggleRecording: () => toggleRecording(),
    onUploadRequested: () => requestTranscriptUpload(),
    onRecordingsChanged: () => fireRecordingsChanged(),
    onError: (error, context) => reportUnexpectedError(error, context),
  });

  transcriptUploadInput.addEventListener("change", () => {
    const file = transcriptUploadInput.files?.[0];
    transcriptUploadInput.value = "";
    if (!file) {
      return;
    }
    void transcribeUploadedFile(file);
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
      onStatus: () => {
        updateAsrLoadingIndicator();
      },
      onCrash: (message) => {
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
    onStateChange: (state) => {
      pluginState = state;
      renderPluginStatus();
    },
  });
  dictation = new DictationController({
    pluginPlatform,
    capture,
    sampleRate: SAMPLE_RATE,
    silenceRms: asrSettings.silenceRms,
    silencePeak: asrSettings.silencePeak,
    silenceHangoverMs: asrSettings.silenceHangoverMs,
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
    updateAsrLoadingIndicator();
    if (nextRoute.name === "recording" && asrSettings.asrEnabled) {
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
  toggleLlmBtn.textContent = running ? "Stop LLM Service" : "Start LLM Service";
}

function renderPluginStatus(): void {
  if (!pluginState) {
    pluginSummaryEl.textContent = "Plugin registry loading...";
    llmStatusEl.textContent = "LLM service: unavailable";
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    updateLlmControls();
    renderPluginList();
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
  renderPluginList();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function renderPluginList(): void {
  // Scoped to LLM for now
  const plugins = pluginState?.plugins.filter((p) => p.kind === "llm") ?? [];
  const activeId = pluginState?.activeLlm?.pluginId ?? null;

  if (plugins.length === 0) {
    pluginListEl.innerHTML =
      '<p class="plugin-list-empty">No models imported yet.</p>';
    return;
  }

  pluginListEl.innerHTML = "";
  for (const plugin of plugins) {
    const row = document.createElement("div");
    row.className = "plugin-row";

    const info = document.createElement("div");
    info.className = "plugin-info";

    const name = document.createElement("div");
    name.className = "plugin-name";
    name.textContent = plugin.name;
    info.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "plugin-meta";
    const parts: string[] = [plugin.kind.toUpperCase()];
    if (plugin.pluginId === activeId) parts.push("active");
    if (plugin.sizeBytes) parts.push(formatFileSize(plugin.sizeBytes));
    meta.textContent = parts.join(" / ");
    info.appendChild(meta);

    row.appendChild(info);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "plugin-delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => {
      void deletePlugin(plugin.pluginId, plugin.name);
    });
    row.appendChild(deleteBtn);

    pluginListEl.appendChild(row);
  }
}

async function deletePlugin(pluginId: string, name: string): Promise<void> {
  const confirmFn = window.confirm as unknown as (message?: string) => unknown;
  const confirmed = await confirmFn(
    `Delete "${name}"? This removes the model file permanently.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    await pluginPlatform.removePlugin(pluginId);
    await initializePlugins();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    llmStatusEl.textContent = `Delete failed: ${message}`;
  }
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

    llmStatusEl.textContent = "Importing model\u2026 0%";
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{
      copiedBytes: number;
      totalBytes: number;
    }>("plugin-import-progress", (event) => {
      const { copiedBytes, totalBytes } = event.payload;
      if (totalBytes > 0) {
        const pct = Math.round((copiedBytes / totalBytes) * 100);
        llmStatusEl.textContent = `Importing model\u2026 ${pct}%`;
      }
    });
    let imported;
    try {
      imported = await pluginPlatform.importFromPath({
        sourcePath,
        displayName: displayName?.trim() || undefined,
      });
    } finally {
      unlisten();
    }
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
    updateLlmControls();
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

function mustFileInput(id: string): HTMLInputElement {
  const el = mustEl(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  if (el.type !== "file") {
    throw new Error(`#${id} is not a file input`);
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

function updateAsrLoadingIndicator(): void {
  const hasTranscription = isAsrTranscriptionEnabled();
  const isReady = hasTranscription && pluginPlatform.isAsrReady();
  const isLoading = asrLoadTask !== null;
  const showLoading = hasTranscription && isLoading && !isReady;

  recordingView?.setModelLoading(
    currentRoute?.name === "recording" && showLoading,
  );
}

async function loadModel(): Promise<boolean> {
  if (!asrSettings.asrEnabled) {
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    return false;
  }

  if (pluginPlatform.isAsrReady()) {
    updateAsrLoadingIndicator();
    return true;
  }

  if (!pluginState?.features.transcription) {
    recordingView.setTranscribeAvailable(false);
    updateAsrLoadingIndicator();
    return false;
  }

  if (asrLoadTask) {
    return asrLoadTask;
  }

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

function requestTranscriptUpload(): void {
  if (dictation.isRecording) {
    showAppError("Stop recording before uploading a file.");
    return;
  }
  transcriptUploadInput.click();
}

async function transcribeUploadedFile(file: File): Promise<void> {
  if (!isAsrTranscriptionEnabled()) {
    return;
  }
  if (dictation.isRecording) {
    showAppError("Stop recording before uploading a file.");
    return;
  }

  recordingView.setUploading(true);
  try {
    if (file.size > MAX_UPLOAD_BYTES) {
      const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
      showAppError(
        `File is too large (${file.name}). Max upload is ${limitMb} MB.`,
      );
      return;
    }
    if (!dictation.isAsrReady()) {
      const loaded = await loadModel();
      if (!loaded) {
        return;
      }
    }

    const samples = await decodeAudioFileToSamples(file, SAMPLE_RATE);
    if (samples.length === 0) {
      showAppError(`No audio detected in "${file.name}".`);
      return;
    }

    const transcript = await pluginPlatform.transcribe(samples);
    await recordingView.onRecordingComplete(transcript);
  } catch (error) {
    reportUnexpectedError(error, `Failed to transcribe file "${file.name}"`);
  } finally {
    recordingView.setUploading(false);
  }
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
