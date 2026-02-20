import { decodeAudioFileToSamples } from "./audio/upload";
import { AudioCapture } from "./audio/capture";
import {
  readAsrSettings,
  sanitizeAsrSettings,
  writeAsrSettings,
  type AsrSettings,
} from "./asr/settings";
import { AsrSettingsController } from "./app/asr-settings-controller";
import { DictationController } from "./app/dictation-controller";
import { ListController, fireRecordingsChanged } from "./app/list";
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
  type PluginPlatform,
  type PluginPlatformState,
} from "./plugins";
import { getRecordingStore } from "./storage";

const SAMPLE_RATE = 16000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MODEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEBUG_METRICS = isDebugMetricsEnabled();
const asrSettings = loadAsrSettings();

const capture = new AudioCapture({ sampleRate: SAMPLE_RATE });
const appBase = new URL("./", window.location.href);
const ortDir = new URL("ort/", appBase).href;

let pluginPlatform: PluginPlatform;
let pluginState: PluginPlatformState | null = null;
let dictation: DictationController;
let recordingView: RecordingViewController;
let listController: ListController;

let appErrorEl: HTMLElement;
let settingsBtn: HTMLButtonElement;
let uploadTranscriptBtn: HTMLButtonElement;
let transcriptUploadInput: HTMLInputElement;
let pluginListEl: HTMLElement;
let importPluginBtn: HTMLButtonElement;
let navBtns: HTMLButtonElement[] = [];
let screenEls: Record<RouteName, HTMLElement>;
let currentRoute: AppRoute | null = null;
let currentRouteStateKey = "";
let lastMainRoute: AppRoute = { name: "list" };
let routeSeq = 0;
let pluginActivationTask: Promise<void> | null = null;
let modelIdleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
let modelIdleUnloadTask: Promise<void> | null = null;

window.addEventListener("DOMContentLoaded", () => {
  appErrorEl = mustEl("appError");
  settingsBtn = mustBtn("settingsBtn");
  uploadTranscriptBtn = mustBtn("uploadTranscriptBtn");
  transcriptUploadInput = mustFileInput("transcriptUploadInput");
  pluginListEl = mustEl("pluginList");
  importPluginBtn = mustBtn("importPluginBtn");

  const asrSettingsController = new AsrSettingsController({
    isRecording: () => dictation?.isRecording ?? false,
    onError: (error, context) => reportUnexpectedError(error, context),
  });
  asrSettingsController.populate(asrSettings);

  const asrEnabledInput = document.getElementById(
    "asrEnabled",
  ) as HTMLInputElement;
  const beamSearchInput = document.getElementById(
    "asrBeamSearchEnabled",
  ) as HTMLInputElement;
  asrEnabledInput.addEventListener("change", () => {
    void applyAsrEnabled(asrEnabledInput.checked);
  });
  beamSearchInput.addEventListener("change", () => {
    void applyBeamSearch(beamSearchInput.checked);
  });

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
  window.addEventListener("error", (event) => {
    reportUnexpectedError(event.error ?? event.message, "Runtime error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    reportUnexpectedError(event.reason, "Unhandled async error");
  });

  window.addEventListener("beforeunload", () => {
    clearModelUnloadTimer();
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

    const leavingRecording =
      currentRoute?.name === "recording" && nextRoute.name !== "recording";
    const enteringRecording = nextRoute.name === "recording";
    if (leavingRecording) {
      scheduleModelUnloadAfterIdle();
    }
    if (enteringRecording) {
      clearModelUnloadTimer();
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
    if (nextRoute.name === "recording") {
      ensureRecordingServicesLoaded();
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
    renderPluginStatus();
    if (currentRoute?.name === "recording") {
      ensureRecordingServicesLoaded();
    }
  } catch (error) {
    reportUnexpectedError(error, "Plugin init failed");
    throw error;
  }
}

async function refreshPluginState(): Promise<void> {
  pluginState = await pluginPlatform.status();
  renderPluginStatus();
}

function updateSettingsControls(): void {
  importPluginBtn.disabled = !(pluginState?.canImport ?? false);
}

function renderPluginStatus(): void {
  recordingView.setTranscribeAvailable(isAsrTranscriptionEnabled());
  updateAsrLoadingIndicator();
  updateSettingsControls();
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
  const llmState = pluginPlatform.getLlmLoadState();
  const controlsDisabled =
    pluginActivationTask !== null ||
    llmState === "loading" ||
    llmState === "unloading" ||
    modelIdleUnloadTask !== null;

  if (plugins.length === 0) {
    pluginListEl.innerHTML =
      '<p class="plugin-list-empty">No plugins imported yet.</p>';
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
    meta.textContent = plugin.sizeBytes ? formatFileSize(plugin.sizeBytes) : "";
    info.appendChild(meta);

    row.appendChild(info);

    const controls = document.createElement("div");
    controls.className = "plugin-controls";

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "plugin-enabled-toggle";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = plugin.pluginId === activeId;
    enabledInput.disabled = controlsDisabled;
    enabledInput.addEventListener("change", () => {
      void setPluginEnabled(plugin.pluginId, enabledInput.checked);
    });
    const enabledText = document.createElement("span");
    enabledText.textContent = "Enabled";
    enabledLabel.append(enabledInput, enabledText);
    controls.appendChild(enabledLabel);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "plugin-delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.type = "button";
    deleteBtn.disabled = controlsDisabled;
    deleteBtn.addEventListener("click", () => {
      void deletePlugin(plugin.pluginId, plugin.name);
    });
    controls.appendChild(deleteBtn);

    row.appendChild(controls);

    pluginListEl.appendChild(row);
  }
}

async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  if (pluginActivationTask) {
    await pluginActivationTask;
  }

  if (!enabled && pluginPlatform.isLlmBusy()) {
    const proceed = window.confirm(
      "A plugin is still processing a request. " +
        "Press OK to stop now, or Cancel to wait.",
    );
    if (!proceed) {
      renderPluginList();
      return;
    }
  }

  const activeId = pluginState?.activeLlm?.pluginId ?? null;
  const nextId = enabled ? pluginId : null;
  if (activeId === nextId) {
    return;
  }

  pluginActivationTask = (async () => {
    await pluginPlatform.setActivePlugin("llm", nextId);
    await refreshPluginState();
    if (isRecordingRouteOpen() && nextId) {
      await setLlmLoaded(true).catch(() => undefined);
    }
  })()
    .catch((error) => {
      reportUnexpectedError(error, "Failed to update plugin state");
    })
    .finally(() => {
      pluginActivationTask = null;
      updateSettingsControls();
      renderPluginList();
    });

  await pluginActivationTask;
}

async function deletePlugin(pluginId: string, name: string): Promise<void> {
  const confirmFn = window.confirm as unknown as (message?: string) => unknown;
  const confirmed = await confirmFn(
    `Delete "${name}"? This removes the plugin permanently.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    await pluginPlatform.removePlugin(pluginId);
    await refreshPluginState();
  } catch (error) {
    reportUnexpectedError(error, "Delete failed");
  }
}

async function importPlugin(): Promise<void> {
  if (!pluginState?.canImport) {
    showAppError("Imports are only available in the desktop app");
    return;
  }

  importPluginBtn.disabled = true;
  try {
    const sourcePath = await pluginPlatform.pickImportPath();
    if (!sourcePath) {
      return;
    }

    const displayName = window.prompt(
      "Optional display name for this plugin (leave blank to use filename):",
      "",
    );

    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{
      copiedBytes: number;
      totalBytes: number;
    }>("plugin-import-progress", () => undefined);
    let imported;
    try {
      imported = await pluginPlatform.importFromPath({
        sourcePath,
        displayName: displayName?.trim() || undefined,
      });
    } finally {
      unlisten();
    }
    await refreshPluginState();
    if (
      imported.kind === "asr" &&
      asrSettings.asrEnabled &&
      currentRoute?.name === "recording"
    ) {
      await setAsrLoaded(true).catch(() => undefined);
    }
  } catch (error) {
    reportUnexpectedError(error, "Import failed");
  } finally {
    importPluginBtn.disabled = false;
    updateSettingsControls();
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
  const isLoading = pluginPlatform.getAsrLoadState() === "loading";
  const showLoading = hasTranscription && isLoading && !isReady;

  recordingView?.setModelLoading(
    currentRoute?.name === "recording" && showLoading,
  );
}

function clearModelUnloadTimer(): void {
  if (modelIdleUnloadTimer === null) {
    return;
  }
  window.clearTimeout(modelIdleUnloadTimer);
  modelIdleUnloadTimer = null;
}

function scheduleModelUnloadAfterIdle(): void {
  clearModelUnloadTimer();
  modelIdleUnloadTimer = window.setTimeout(() => {
    modelIdleUnloadTimer = null;
    void unloadModelsAfterIdle();
  }, MODEL_IDLE_TIMEOUT_MS);
}

async function unloadModelsAfterIdle(): Promise<void> {
  if (isRecordingRouteOpen()) {
    return;
  }
  if (modelIdleUnloadTask) {
    return modelIdleUnloadTask;
  }

  modelIdleUnloadTask = (async () => {
    if (!isRecordingRouteOpen()) {
      await Promise.allSettled([setAsrLoaded(false), setLlmLoaded(false)]);
    }
  })()
    .catch((error) => {
      console.error("Idle model unload failed:", error);
    })
    .finally(() => {
      modelIdleUnloadTask = null;
      updateAsrLoadingIndicator();
      updateSettingsControls();
    });

  return modelIdleUnloadTask;
}

function ensureRecordingServicesLoaded(): void {
  clearModelUnloadTimer();
  if (asrSettings.asrEnabled && pluginState?.features.transcription) {
    void setAsrLoaded(true).catch((error) =>
      reportUnexpectedError(error, "ASR load failed"),
    );
  }
  if (pluginState?.features.llm) {
    void setLlmLoaded(true).catch((error) =>
      reportUnexpectedError(error, "Plugin load failed"),
    );
  }
}

async function applyAsrEnabled(enabled: boolean): Promise<void> {
  asrSettings.asrEnabled = enabled;
  try {
    writeAsrSettings(asrSettings);
  } catch {
    // Best-effort persist; value is already applied in memory
  }

  if (!enabled) {
    await setAsrLoaded(false).catch(() => undefined);
  } else if (isRecordingRouteOpen() && pluginState?.features.transcription) {
    void setAsrLoaded(true).catch((error) =>
      reportUnexpectedError(error, "ASR load failed"),
    );
  }
  recordingView.setTranscribeAvailable(isAsrTranscriptionEnabled());
  updateAsrLoadingIndicator();
}

async function applyBeamSearch(enabled: boolean): Promise<void> {
  asrSettings.runtimeConfig.decode.beamSearchEnabled = enabled;
  try {
    writeAsrSettings(asrSettings);
  } catch {
    // Best-effort persist
  }

  // Beam search config is baked into the worker at load time, so cycle ASR
  if (pluginPlatform.isAsrReady()) {
    await setAsrLoaded(false).catch(() => undefined);
    if (asrSettings.asrEnabled && isRecordingRouteOpen()) {
      void setAsrLoaded(true).catch((error) =>
        reportUnexpectedError(error, "ASR load failed"),
      );
    }
  }
}

async function setAsrLoaded(
  loaded: boolean,
  options?: { force?: boolean },
): Promise<boolean> {
  await pluginPlatform.setAsrLoaded(loaded, options);
  await refreshPluginState();
  return pluginPlatform.isAsrReady();
}

async function setLlmLoaded(
  loaded: boolean,
  options?: { force?: boolean },
): Promise<boolean> {
  await pluginPlatform.setLlmLoaded(loaded, options);
  await refreshPluginState();
  return pluginState?.llmRunning ?? false;
}

async function toggleRecording(): Promise<void> {
  if (!isAsrTranscriptionEnabled()) {
    return;
  }

  if (!dictation.isAsrReady()) {
    const loaded = await setAsrLoaded(true);
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
      const loaded = await setAsrLoaded(true);
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

function isRecordingRouteOpen(): boolean {
  return currentRoute?.name === "recording";
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
