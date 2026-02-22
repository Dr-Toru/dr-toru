import { decodeAudioFileToSamples } from "./audio/upload";
import { AudioCapture } from "./audio/capture";
import {
  DEFAULT_ASR_SETTINGS,
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
import {
  BUILTIN_MED_ASR_PLUGIN_ID,
  type PluginManifest,
} from "./plugins/contracts";
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
let appErrorTextEl: HTMLElement;
let appErrorDismissBtn: HTMLButtonElement;
let settingsBtn: HTMLButtonElement;
let uploadTranscriptBtn: HTMLButtonElement;
let transcriptUploadInput: HTMLInputElement;
let pluginListEl: HTMLElement;
let asrPluginSettingsPanelEl: HTMLElement;
let importPluginBtn: HTMLButtonElement;
let importProgressEl: HTMLElement;
let importProgressLabel: HTMLElement;
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
  appErrorTextEl = mustEl("appErrorText");
  appErrorDismissBtn = mustBtn("appErrorDismissBtn");
  appErrorDismissBtn.addEventListener("click", hideAppError);
  settingsBtn = mustBtn("settingsBtn");
  uploadTranscriptBtn = mustBtn("uploadTranscriptBtn");
  transcriptUploadInput = mustFileInput("transcriptUploadInput");
  pluginListEl = mustEl("pluginList");
  asrPluginSettingsPanelEl = mustEl("asrPluginSettingsPanel");
  importPluginBtn = mustBtn("importPluginBtn");
  importProgressEl = mustEl("importProgress");
  importProgressLabel = importProgressEl.querySelector(
    ".import-progress-label",
  ) as HTMLElement;

  const asrSettingsController = new AsrSettingsController({
    isRecording: () => dictation?.isRecording ?? false,
    onError: (error, context) => reportUnexpectedError(error, context),
  });
  asrSettingsController.populate(asrSettings);

  const beamSearchInput = mustInput("asrBeamSearchEnabled");
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

  const backBtn = mustBtn("backBtn");
  backBtn.addEventListener("click", () => {
    void setRoute({ name: "list" }, true);
  });

  recordingView = new RecordingViewController({
    transcriptEl: mustEl("transcript"),
    contextNoteEl: mustTextarea("contextNote"),
    transcribeBtn: mustBtn("recordBtn"),
    uploadBtn: uploadTranscriptBtn,
    soapBtn: mustBtn("soapBtn"),
    soapSectionEl: mustEl("soapSection"),
    soapContentEl: mustEl("soapContent"),
    soapBlankStateEl: mustEl("soapBlankState"),
    soapCopyBtn: mustBtn("soapCopyBtn"),
    soapOverlayEl: mustEl("soapOverlay"),
    treatmentSummaryBtn: mustBtn("treatmentSummaryBtn"),
    treatmentSummarySectionEl: mustEl("treatmentSummarySection"),
    treatmentSummaryContentEl: mustEl("treatmentSummaryContent"),
    treatmentSummaryBlankStateEl: mustEl("treatmentSummaryBlankState"),
    treatmentSummaryCopyBtn: mustBtn("treatmentSummaryCopyBtn"),
    treatmentSummaryOverlayEl: mustEl("treatmentSummaryOverlay"),
    backBtn,
    titleBtn: mustBtn("subviewTitleBtn"),
    titleLabel: mustEl("subviewTitleLabel"),
    dropdown: mustEl("subviewDropdown"),
    transcriptSubview: mustEl("subviewTranscript"),
    contextSubview: mustEl("subviewContext"),
    soapSubview: mustEl("subviewSoap"),
    summarySubview: mustEl("subviewSummary"),
    timerEl: mustEl("recordingTimer"),
    typingIndicatorEl: mustEl("typingIndicator"),
    recordingService,
    platform: pluginPlatform,
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

  const contextCopyBtn = mustBtn("contextCopyBtn");
  contextCopyBtn.addEventListener("click", () => {
    const text = mustTextarea("contextNote").value.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      contextCopyBtn.textContent = "Copied";
      contextCopyBtn.classList.add("copied");
      setTimeout(() => {
        contextCopyBtn.textContent = "Copy";
        contextCopyBtn.classList.remove("copied");
      }, 1500);
    });
  });

  const soapCopyBtn = mustBtn("soapCopyBtn");
  soapCopyBtn.addEventListener("click", () => {
    const soapEl = mustEl("soapContent");
    const text = soapEl.textContent?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      soapCopyBtn.textContent = "Copied";
      soapCopyBtn.classList.add("copied");
      setTimeout(() => {
        soapCopyBtn.textContent = "Copy";
        soapCopyBtn.classList.remove("copied");
      }, 1500);
    });
  });

  const treatmentSummaryCopyBtn = mustBtn("treatmentSummaryCopyBtn");
  treatmentSummaryCopyBtn.addEventListener("click", () => {
    const el = mustEl("treatmentSummaryContent");
    const text = el.textContent?.trim();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      treatmentSummaryCopyBtn.textContent = "Copied";
      treatmentSummaryCopyBtn.classList.add("copied");
      setTimeout(() => {
        treatmentSummaryCopyBtn.textContent = "Copy";
        treatmentSummaryCopyBtn.classList.remove("copied");
      }, 1500);
    });
  });

  listController = new ListController({
    container: mustEl("recording-list"),
    store,
    searchInput: mustInput("recordingSearchInput"),
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
    if (!pluginState.activeAsr) {
      const builtInAsrId = findBuiltInAsrPluginId();
      if (builtInAsrId) {
        await pluginPlatform.setActivePlugin("asr", builtInAsrId);
        pluginState = await pluginPlatform.status();
      }
    }
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
  if (!pluginState.activeAsr) {
    const builtInAsrId = findBuiltInAsrPluginId();
    if (builtInAsrId) {
      await pluginPlatform.setActivePlugin("asr", builtInAsrId);
      pluginState = await pluginPlatform.status();
    }
  }
  renderPluginStatus();
}

function updateSettingsControls(): void {
  importPluginBtn.disabled = !(pluginState?.canImport ?? false);
}

function renderPluginStatus(): void {
  syncDictationTuningForActiveAsr();
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

function formatPluginKindLabel(plugin: PluginManifest): string {
  if (plugin.kind === "llm") {
    return "Text Generation";
  }
  const language = parseAsrLanguage(plugin.metadata);
  return language ? `Dictation (${language})` : "Dictation";
}

function parseAsrLanguage(metadata: PluginManifest["metadata"]): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const asRecord = metadata as Record<string, unknown>;
  const direct = normalizeMetadataText(asRecord.language);
  if (direct) {
    return direct;
  }

  const runtimeConfig = asRecord.runtimeConfig;
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    return null;
  }
  const asRuntimeRecord = runtimeConfig as Record<string, unknown>;
  return normalizeMetadataText(asRuntimeRecord.language);
}

function normalizeMetadataText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text : null;
}

function renderPluginList(): void {
  const plugins =
    pluginState?.plugins.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind.localeCompare(b.kind);
      }
      const aBuiltin = a.pluginId.startsWith("builtin.");
      const bBuiltin = b.pluginId.startsWith("builtin.");
      if (aBuiltin !== bBuiltin) {
        return aBuiltin ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    }) ?? [];
  const activeAsrId = pluginState?.activeAsr?.pluginId ?? null;
  const activeLlmId = pluginState?.activeLlm?.pluginId ?? null;
  const llmState = pluginPlatform.getLlmLoadState();
  const asrState = pluginPlatform.getAsrLoadState();
  let panelAttached = false;

  if (plugins.length === 0) {
    pluginListEl.innerHTML =
      '<p class="plugin-list-empty">No plugins imported yet.</p>';
    asrPluginSettingsPanelEl.hidden = true;
    return;
  }

  pluginListEl.innerHTML = "";
  for (const plugin of plugins) {
    const isBuiltIn = plugin.pluginId.startsWith("builtin.");
    const activeId = plugin.kind === "asr" ? activeAsrId : activeLlmId;
    const loadState = plugin.kind === "asr" ? asrState : llmState;
    const controlsDisabled =
      pluginActivationTask !== null ||
      loadState === "loading" ||
      loadState === "unloading" ||
      modelIdleUnloadTask !== null;

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
    const metaParts = [formatPluginKindLabel(plugin)];
    if (isBuiltIn) {
      metaParts.push("Built-in");
    }
    if (plugin.sizeBytes) {
      metaParts.push(formatFileSize(plugin.sizeBytes));
    }
    meta.textContent = metaParts.join(" · ");
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
      void setPluginEnabled(plugin.kind, plugin.pluginId, enabledInput.checked);
    });
    const enabledText = document.createElement("span");
    enabledText.textContent = "Enabled";
    enabledLabel.append(enabledInput, enabledText);
    controls.appendChild(enabledLabel);

    if (!isBuiltIn) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "plugin-delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.type = "button";
      deleteBtn.disabled = controlsDisabled;
      deleteBtn.addEventListener("click", () => {
        void deletePlugin(plugin.pluginId, plugin.name);
      });
      controls.appendChild(deleteBtn);
    }

    row.appendChild(controls);

    if (plugin.kind === "asr" && plugin.pluginId === activeAsrId) {
      const ownsSettings = ownsAsrSettingsPanel(
        plugin.pluginId,
        plugin.runtime,
      );
      if (!ownsSettings) {
        pluginListEl.appendChild(row);
        continue;
      }
      updateBeamSearchAvailabilityForRuntime(plugin.runtime);
      asrPluginSettingsPanelEl.hidden = false;
      row.appendChild(asrPluginSettingsPanelEl);
      panelAttached = true;
    }

    pluginListEl.appendChild(row);
  }

  if (!panelAttached) {
    asrPluginSettingsPanelEl.hidden = true;
  }
}

function findBuiltInAsrPluginId(): string | null {
  const medAsr = pluginState?.plugins.find(
    (plugin) =>
      plugin.kind === "asr" && plugin.pluginId === BUILTIN_MED_ASR_PLUGIN_ID,
  );
  if (medAsr) {
    return medAsr.pluginId;
  }
  const fallback = pluginState?.plugins.find(
    (plugin) => plugin.kind === "asr" && plugin.pluginId.startsWith("builtin."),
  );
  return fallback?.pluginId ?? null;
}

async function setPluginEnabled(
  kind: "asr" | "llm",
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  if (pluginActivationTask) {
    await pluginActivationTask;
  }

  if (!enabled) {
    const busy =
      kind === "asr" ? pluginPlatform.isAsrBusy() : pluginPlatform.isLlmBusy();
    if (busy) {
      const proceed = window.confirm(
        kind === "asr"
          ? "ASR is still transcribing. Press OK to stop now, or Cancel to wait."
          : "A plugin is still processing a request. Press OK to stop now, or Cancel to wait.",
      );
      if (!proceed) {
        renderPluginList();
        return;
      }
    }
  }

  const activeId =
    kind === "asr"
      ? (pluginState?.activeAsr?.pluginId ?? null)
      : (pluginState?.activeLlm?.pluginId ?? null);
  let nextId = enabled ? pluginId : null;
  if (kind === "asr" && !enabled) {
    nextId = findBuiltInAsrPluginId();
  }
  if (activeId === nextId) {
    renderPluginList();
    return;
  }

  pluginActivationTask = (async () => {
    await pluginPlatform.setActivePlugin(kind, nextId);
    await refreshPluginState();
    if (isRecordingRouteOpen() && nextId && kind === "asr") {
      await setAsrLoaded(true).catch(() => undefined);
    }
    if (isRecordingRouteOpen() && nextId && kind === "llm") {
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
    importProgressLabel.textContent = "Importing\u2026";
    importProgressEl.hidden = false;
    const unlisten = await listen<{
      copiedBytes: number;
      totalBytes: number;
    }>("plugin-import-progress", (event) => {
      const { copiedBytes, totalBytes } = event.payload;
      if (totalBytes > 0) {
        const pct = Math.min(100, Math.round((copiedBytes / totalBytes) * 100));
        importProgressLabel.textContent = `${pct}%`;
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
      importProgressEl.hidden = true;
    }
    await refreshPluginState();
    if (imported.kind === "asr" && currentRoute?.name === "recording") {
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
  const el = mustInput(id);
  if (el.type !== "file") {
    throw new Error(`#${id} is not a file input`);
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
  appErrorTextEl.textContent = message;
  appErrorEl.hidden = false;
}

function hideAppError(): void {
  appErrorEl.hidden = true;
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
  if (pluginState?.features.transcription) {
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

function updateBeamSearchAvailabilityForRuntime(runtime: string): void {
  const beamSearchInput = document.getElementById("asrBeamSearchEnabled");
  const beamMeta = document.getElementById("beamSearchMeta");
  if (!(beamSearchInput instanceof HTMLInputElement)) {
    return;
  }

  const beamSupported = runtime === "ort-ctc";
  beamSearchInput.disabled = !beamSupported;
  if (!beamSupported) {
    beamSearchInput.checked = false;
    if (asrSettings.runtimeConfig.decode.beamSearchEnabled) {
      asrSettings.runtimeConfig.decode.beamSearchEnabled = false;
      try {
        writeAsrSettings(asrSettings);
      } catch {
        // Best-effort persist
      }
    }
  }

  if (beamMeta instanceof HTMLElement) {
    beamMeta.textContent = beamSupported
      ? "Improves quality but uses more memory"
      : "Unavailable for current ASR plugin";
  }
}

function ownsAsrSettingsPanel(pluginId: string, runtime: string): boolean {
  return pluginId === BUILTIN_MED_ASR_PLUGIN_ID && runtime === "ort-ctc";
}

function syncDictationTuningForActiveAsr(): void {
  const activeAsr = pluginState?.activeAsr;
  const tuningSource =
    activeAsr && ownsAsrSettingsPanel(activeAsr.pluginId, activeAsr.runtime)
      ? asrSettings
      : DEFAULT_ASR_SETTINGS;
  dictation.setVadSettings({
    silenceRms: tuningSource.silenceRms,
    silencePeak: tuningSource.silencePeak,
    silenceHangoverMs: tuningSource.silenceHangoverMs,
  });
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
    if (isRecordingRouteOpen() && pluginState?.features.transcription) {
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
  return Boolean(pluginState?.features.transcription);
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
