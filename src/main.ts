import { AudioCapture } from "./audio/capture";
import { ARTIFACT_TEMPLATES } from "./app/artifact-prompts";
import { DetailViewController } from "./app/detail-view-controller";
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

const CHUNK_SECS = Math.max(2, readNumericSetting("toru.chunk.secs", 6));
const STRIDE_SECS = Math.min(
  readNumericSetting("toru.stride.secs", 1.5),
  Math.max(0.5, CHUNK_SECS - 0.5),
);
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = Math.floor(CHUNK_SECS * SAMPLE_RATE);
const STRIDE_SAMPLES = Math.floor(STRIDE_SECS * SAMPLE_RATE);
const CHUNK_STEP_SAMPLES = Math.max(
  Math.floor(0.75 * SAMPLE_RATE),
  CHUNK_SAMPLES - STRIDE_SAMPLES,
);
const SILENCE_RMS = readNumericSetting("toru.silence.rms", 0.0025);
const SILENCE_PEAK = readNumericSetting("toru.silence.peak", 0.012);
const SILENCE_HOLD_CHUNKS = Math.max(
  0,
  Math.floor(readNumericSetting("toru.silence.hold.chunks", 2)),
);
const SILENCE_PROBE_EVERY = Math.max(
  1,
  Math.floor(readNumericSetting("toru.silence.probe.every", 8)),
);
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
let recordingView: RecordingViewController;
let detailView: DetailViewController;
let listController: ListController;

let pluginSummaryEl: HTMLElement;
let llmStatusEl: HTMLElement;
let llmOutputEl: HTMLElement;
let appErrorEl: HTMLElement;
let asrLoadingEl: HTMLElement;
let settingsBtn: HTMLButtonElement;
let importPluginBtn: HTMLButtonElement;
let toggleLlmBtn: HTMLButtonElement;
let runLlmBtn: HTMLButtonElement;
let createBtn: HTMLButtonElement;
let detailBackBtn: HTMLButtonElement;
let llmInputEl: HTMLTextAreaElement;
let createOverlayEl: HTMLElement;
let createSheetEl: HTMLElement;
let templateListEl: HTMLElement;
let processingOverlayEl: HTMLElement;
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
  llmOutputEl = mustEl("llmOutput");
  appErrorEl = mustEl("appError");
  asrLoadingEl = mustEl("asrLoading");
  settingsBtn = mustBtn("settingsBtn");
  importPluginBtn = mustBtn("importPluginBtn");
  toggleLlmBtn = mustBtn("toggleLlmBtn");
  runLlmBtn = mustBtn("runLlmBtn");
  createBtn = mustBtn("createBtn");
  detailBackBtn = mustBtn("detailBackBtn");
  llmInputEl = mustTextarea("llmInput");
  createOverlayEl = mustEl("create-overlay");
  createSheetEl = mustEl("create-sheet");
  templateListEl = mustEl("template-list");
  processingOverlayEl = mustEl("processingOverlay");
  screenEls = {
    recording: mustEl("screen-recording"),
    list: mustEl("screen-list"),
    settings: mustEl("screen-settings"),
    detail: mustEl("screen-detail"),
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
  recordingService = new RecordingService(store);

  const barEls = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#screen-recording .status-indicator .bar",
    ),
  );

  recordingView = new RecordingViewController({
    transcriptEl: mustTextarea("transcript"),
    contextNoteEl: mustTextarea("contextNote"),
    transcribeBtn: mustBtn("recordBtn"),
    timerEl: mustEl("recordingTimer"),
    barEls,
    typingIndicatorEl: mustEl("typingIndicator"),
    artifactCardsEl: mustEl("artifactCards"),
    recordingService,
    onToggleRecording: () => toggleRecording(),
    onRecordingsChanged: () => fireRecordingsChanged(),
    onArtifactTap: (recordingId, attachmentId) => {
      void setRoute({ name: "detail", recordingId, attachmentId }, true);
    },
    onError: (error, context) => reportUnexpectedError(error, context),
  });

  detailView = new DetailViewController({
    contentEl: mustEl("detailContent"),
    typeEl: mustEl("detailType"),
    dateEl: mustEl("detailDate"),
    copyBtn: mustBtn("detailCopyBtn"),
    deleteBtn: mustBtn("detailDeleteBtn"),
    recordingService,
    onDeleted: (recordingId) => {
      void setRoute({ name: "recording", recordingId }, true);
      fireRecordingsChanged();
    },
    onError: (error, context) => reportUnexpectedError(error, context),
  });

  listController = new ListController({
    container: mustEl("recording-list"),
    store,
    onSelect: (recordingId) => {
      void setRoute({ name: "recording", recordingId }, true);
    },
  });

  // Create button → open sheet
  createBtn.addEventListener("click", () => {
    openCreateSheet();
  });

  // Detail back button → return to recording
  detailBackBtn.addEventListener("click", () => {
    const rid = recordingView.getRecordingId();
    if (rid) {
      void setRoute({ name: "recording", recordingId: rid }, true);
    } else {
      void setRoute({ name: "list" }, true);
    }
  });

  // Close sheet on overlay click
  createOverlayEl.addEventListener("click", () => {
    closeCreateSheet();
  });

  // Populate template list
  renderTemplateList();

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
    asrEvents: {
      onStatus: () => undefined,
      onCrash: (message) => {
        dictation.handleAsrCrash(message);
        recordingView.setTranscribeAvailable(
          Boolean(pluginState?.features.transcription),
        );
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
    speechHoldChunks: SILENCE_HOLD_CHUNKS,
    silenceProbeEvery: SILENCE_PROBE_EVERY,
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
  void initializePlugins()
    .then(() => {
      void loadModel();
    })
    .catch((error) => reportUnexpectedError(error, "Startup failed"));
});

async function setRoute(route: AppRoute, syncHash: boolean): Promise<void> {
  try {
    if (
      dictation.isRecording &&
      currentRoute?.name === "recording" &&
      route.name !== "recording" &&
      route.name !== "detail"
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

    if (route.name === "detail") {
      const found = await detailView.openRoute(
        route.recordingId,
        route.attachmentId,
      );
      if (seq !== routeSeq) {
        return;
      }
      if (!found) {
        showAppError("Document not found");
        await setRoute(
          { name: "recording", recordingId: route.recordingId },
          true,
        );
        return;
      }
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

    if (nextRoute.name !== "settings" && nextRoute.name !== "detail") {
      lastMainRoute = nextRoute;
    }

    if (syncHash) {
      syncRouteHash(nextRoute);
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

  pluginSummaryEl.textContent = formatPluginSummary(pluginState);
  llmStatusEl.textContent = formatLlmStatus(pluginState);
  recordingView.setTranscribeAvailable(pluginState.features.transcription);
  updateAsrLoadingIndicator();
  updateLlmControls();
  updateCreateButton();
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
    if (imported.kind === "asr") {
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

function openCreateSheet(): void {
  createOverlayEl.classList.add("visible");
  createSheetEl.classList.add("open");
}

function closeCreateSheet(): void {
  createOverlayEl.classList.remove("visible");
  createSheetEl.classList.remove("open");
}

function renderTemplateList(): void {
  templateListEl.innerHTML = "";
  for (const template of ARTIFACT_TEMPLATES) {
    const btn = document.createElement("button");
    btn.className = "template-btn";
    btn.innerHTML = `<div class="template-info"><span class="template-name">${template.title}</span><span class="template-desc">${template.description}</span></div>`;
    btn.addEventListener("click", () => {
      closeCreateSheet();
      void generateArtifact(template.type, template.systemPrompt);
    });
    templateListEl.appendChild(btn);
  }
}

async function generateArtifact(
  artifactType: string,
  systemPrompt: string,
): Promise<void> {
  const recordingId = recordingView.getRecordingId();
  if (!recordingId) return;

  const transcript = recordingView.getTranscriptText();
  if (!transcript.trim()) {
    showAppError("No transcript to generate from. Record a dictation first.");
    return;
  }

  const context = recordingView.getContextText();
  let input = "";
  if (context.trim()) {
    input += `CONTEXT:\n${context.trim()}\n\n`;
  }
  input += `TRANSCRIPT:\n${transcript.trim()}`;

  processingOverlayEl.classList.add("visible");
  try {
    const output = await llm.runWithPrompt(systemPrompt, input);
    if (!output || !output.trim()) {
      showAppError("LLM returned empty output");
      return;
    }

    await recordingService.saveArtifact({
      recordingId,
      artifactType,
      content: output.trim(),
      sourceTranscriptId: recordingView.getTranscriptAttachmentId(),
      sourceContextId: recordingView.getContextAttachmentId(),
    });

    await recordingView.refreshArtifacts();
    fireRecordingsChanged();
  } catch (error) {
    reportUnexpectedError(error, "Artifact generation failed");
  } finally {
    processingOverlayEl.classList.remove("visible");
  }
}

function updateCreateButton(): void {
  const hasTranscript = Boolean(recordingView.getTranscriptText().trim());
  const llmRunning = llm.isRunning();
  createBtn.disabled = !hasTranscript || !llmRunning;
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
  const hasTranscription = Boolean(pluginState?.features.transcription);
  const isReady = hasTranscription && pluginPlatform.isAsrReady();
  const isLoading = asrLoadTask !== null;
  asrLoadingEl.hidden = !(hasTranscription && isLoading && !isReady);
}

async function loadModel(): Promise<boolean> {
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
  if (!pluginState?.features.transcription) {
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

function isDebugMetricsEnabled(): boolean {
  try {
    return window.localStorage.getItem("toru.debug.metrics") === "1";
  } catch {
    return false;
  }
}

function readNumericSetting(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}
