import type { AsrClientEvents } from "../asr/client";
import type { AsrRuntimeConfig } from "../asr-messages";
import type { PluginManifest } from "./contracts";
import { PluginService } from "./service";
import { createRuntimeAdapter, type RuntimeAdapter } from "./runtime-adapter";
import {
  canUseTauriPluginStore,
  type PluginImportRequest,
  type PluginRegistryStore,
  type PluginServiceHealth,
} from "./store";

export interface PluginPlatformOptions {
  workerUrl: URL;
  ortDir: string;
  appOrigin: string;
  asrRuntimeConfig: AsrRuntimeConfig;
  asrEvents: AsrClientEvents;
}

export interface PluginPlatformState {
  /** True when the plugin registry loaded without errors. Does not imply
   *  any provider is active -- check `features` for capability gates. */
  ready: boolean;
  error: string | null;
  canImport: boolean;
  features: { transcription: boolean; llm: boolean };
  plugins: PluginManifest[];
  activeAsr: PluginManifest | null;
  activeLlm: PluginManifest | null;
  llmCount: number;
  llmRunning: boolean;
  llmStatus: string;
  llmEndpoint: string | null;
}

export type CapabilityLoadState =
  | "unloaded"
  | "loading"
  | "loaded"
  | "unloading";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveAppDataDir(): Promise<string> {
  try {
    const { appDataDir } = await import("@tauri-apps/api/path");
    return await appDataDir();
  } catch {
    return "";
  }
}

export class PluginPlatform {
  private readonly service: PluginService;
  private readonly canImport = canUseTauriPluginStore();
  private initTask: Promise<PluginPlatformState> | null = null;
  private llmLoadTask: Promise<PluginManifest> | null = null;
  private initialized = false;
  private initError: string | null = null;
  private resolvedDataDir = "";
  private plugins: PluginManifest[] = [];
  private activeAsr: PluginManifest | null = null;
  private activeLlm: PluginManifest | null = null;
  private llmCount = 0;
  private llmHealth: PluginServiceHealth | null = null;
  private asrRuntime: RuntimeAdapter | null = null;
  private llmRuntime: RuntimeAdapter | null = null;
  private asrReady = false;
  private asrUnloadTask: Promise<void> | null = null;
  private asrLoadState: CapabilityLoadState = "unloaded";
  private llmLoadState: CapabilityLoadState = "unloaded";
  private asrTargetLoaded = false;
  private llmTargetLoaded = false;
  private asrSetLoadedTask: Promise<void> | null = null;
  private llmSetLoadedTask: Promise<void> | null = null;
  private asrInFlightCount = 0;
  private asrForceUnload = false;
  private asrCancelGeneration = 0;
  private asrIdleResolvers: Array<() => void> = [];
  private llmInFlightCount = 0;
  private llmForceUnload = false;
  private llmCancelGeneration = 0;
  private llmIdleResolvers: Array<() => void> = [];

  constructor(
    store: PluginRegistryStore,
    private readonly options: PluginPlatformOptions,
  ) {
    this.service = new PluginService(store);
  }

  isAsrReady(): boolean {
    return this.asrReady;
  }

  getAsrLoadState(): CapabilityLoadState {
    return this.asrLoadState;
  }

  getLlmLoadState(): CapabilityLoadState {
    return this.llmLoadState;
  }

  isLlmBusy(): boolean {
    return this.llmInFlightCount > 0;
  }

  isAsrBusy(): boolean {
    return this.asrInFlightCount > 0;
  }

  async setAsrLoaded(
    loaded: boolean,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.asrSetLoadedTask) {
      await this.asrSetLoadedTask.catch(() => undefined);
    }
    this.asrTargetLoaded = loaded;
    this.asrForceUnload = !loaded && Boolean(options.force);
    if (!loaded && options.force) {
      this.asrCancelGeneration += 1;
    }
    while (this.asrTargetLoaded !== this.asrReady) {
      const task = this.asrSetLoadedTask ?? this.startAsrSetLoadedLoop();
      await task;
    }
  }

  async setLlmLoaded(
    loaded: boolean,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.llmSetLoadedTask) {
      await this.llmSetLoadedTask.catch(() => undefined);
    }
    this.llmTargetLoaded = loaded;
    this.llmForceUnload = !loaded && Boolean(options.force);
    if (!loaded && options.force) {
      this.llmCancelGeneration += 1;
    }

    while (this.llmTargetLoaded !== this.isLlmRunning()) {
      const task = this.llmSetLoadedTask ?? this.startLlmSetLoadedLoop();
      await task;
    }
  }

  async init(): Promise<PluginPlatformState> {
    const task = this.initTask ?? this.initNow();
    this.initTask = task;

    try {
      return await task;
    } finally {
      if (this.initTask === task) {
        this.initTask = null;
      }
    }
  }

  async status(): Promise<PluginPlatformState> {
    if (this.initTask) {
      await this.initTask;
    } else if (!this.initialized && !this.initError) {
      await this.init();
    } else {
      await this.refreshLlmHealth();
      this.syncCapabilityStates();
    }
    return this.snapshot();
  }

  async pickImportPath(): Promise<string | null> {
    if (!this.canImport) {
      return null;
    }

    const { open } = await import("@tauri-apps/plugin-dialog");
    const sourcePath = await open({
      title: "Import Model File or Package",
      multiple: false,
      filters: [{ name: "Model Files", extensions: ["llamafile", "zip"] }],
    });
    if (typeof sourcePath !== "string") {
      return null;
    }
    return sourcePath;
  }

  async importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    const state = await this.init();
    if (state.error) {
      throw new Error(state.error);
    }
    const imported = await this.service.importFromPath(request);
    await this.init();
    return imported;
  }

  async removePlugin(pluginId: string): Promise<void> {
    await this.service.remove(pluginId);
    await this.init();
  }

  async setActivePlugin(
    kind: "asr" | "llm",
    pluginId: string | null,
  ): Promise<PluginPlatformState> {
    if (kind === "asr") {
      await this.setAsrLoaded(false, { force: true }).catch(() => undefined);
    } else {
      await this.setLlmLoaded(false, { force: true }).catch(() => undefined);
    }
    await this.service.setActivePlugin(kind, pluginId);
    return this.init();
  }

  async loadAsr(): Promise<PluginManifest> {
    if (this.asrUnloadTask) {
      await this.asrUnloadTask;
    }

    const state = await this.init();
    if (state.error) {
      throw new Error(state.error);
    }

    if (!this.activeAsr) {
      throw new Error("No active ASR provider configured");
    }
    const runtime = await this.ensureAsrRuntime();
    await runtime.init();
    const health = await runtime.health();
    if (!health.ready) {
      this.asrReady = false;
      throw new Error(health.message);
    }
    this.asrReady = true;
    return this.activeAsr;
  }

  async transcribe(samples: Float32Array): Promise<string> {
    if (!this.asrReady || !this.asrRuntime) {
      throw new Error("ASR runtime is not ready");
    }
    const cancelGeneration = this.asrCancelGeneration;
    this.asrInFlightCount += 1;
    try {
      const result = await this.asrRuntime.execute({
        type: "asr.transcribe",
        samples,
      });
      if (cancelGeneration !== this.asrCancelGeneration) {
        throw new Error("ASR request canceled");
      }
      return result.text;
    } finally {
      this.asrInFlightCount = Math.max(0, this.asrInFlightCount - 1);
      if (this.asrInFlightCount === 0) {
        const resolvers = this.asrIdleResolvers;
        this.asrIdleResolvers = [];
        for (const resolve of resolvers) {
          resolve();
        }
      }
    }
  }

  async unloadAsr(): Promise<void> {
    this.asrReady = false;
    if (this.asrUnloadTask) {
      await this.asrUnloadTask;
      return;
    }

    const runtime = this.asrRuntime;
    if (!runtime) {
      return;
    }
    this.asrRuntime = null;

    const unloadTask = runtime.shutdown().finally(() => {
      if (this.asrUnloadTask === unloadTask) {
        this.asrUnloadTask = null;
      }
    });
    this.asrUnloadTask = unloadTask;
    await unloadTask;
  }

  async loadLlm(): Promise<PluginManifest> {
    const state = await this.init();
    if (state.error) {
      throw new Error(state.error);
    }
    if (!this.activeLlm) {
      throw new Error("No active LLM provider configured");
    }
    if (this.llmHealth?.running) {
      return this.activeLlm;
    }

    const loadTask =
      this.llmLoadTask ??
      (async () => {
        const activeLlm = this.activeLlm;
        if (!activeLlm) {
          throw new Error("No active LLM provider configured");
        }
        const runtime = await this.ensureLlmRuntime();
        await runtime.init();
        await this.refreshLlmHealth();
        if (!this.llmHealth?.running) {
          throw new Error(this.llmHealth?.message ?? "LLM service failed");
        }
        return activeLlm;
      })();
    this.llmLoadTask = loadTask;

    try {
      return await loadTask;
    } finally {
      if (this.llmLoadTask === loadTask) {
        this.llmLoadTask = null;
      }
    }
  }

  async unloadLlm(): Promise<void> {
    if (this.llmLoadTask) {
      await this.llmLoadTask.catch(() => undefined);
    }
    if (!this.activeLlm) {
      this.llmHealth = null;
      return;
    }

    try {
      if (this.llmRuntime) {
        await this.llmRuntime.shutdown();
        this.llmRuntime = null;
      } else if (this.llmHealth?.running) {
        await this.service.stopService(this.activeLlm.pluginId);
      }
    } finally {
      await this.refreshLlmHealth();
    }
  }

  async runLlm(
    action: string,
    input: string,
    prompt?: string,
  ): Promise<string> {
    const state = await this.init();
    if (state.error) {
      throw new Error(state.error);
    }
    if (!this.activeLlm) {
      throw new Error("No active LLM provider configured");
    }
    if (!this.llmHealth?.running) {
      throw new Error("Start the LLM service first");
    }

    const cancelGeneration = this.llmCancelGeneration;
    this.llmInFlightCount += 1;
    try {
      const runtime = await this.ensureLlmRuntime();
      const result = await runtime.execute({
        type: "llm.transform",
        action,
        input,
        prompt,
      });
      if (cancelGeneration !== this.llmCancelGeneration) {
        throw new Error("LLM request canceled");
      }
      return result.text;
    } catch (error) {
      await this.refreshLlmHealth();
      throw new Error(toErrorMessage(error));
    } finally {
      this.llmInFlightCount = Math.max(0, this.llmInFlightCount - 1);
      if (this.llmInFlightCount === 0) {
        const resolvers = this.llmIdleResolvers;
        this.llmIdleResolvers = [];
        for (const resolve of resolvers) {
          resolve();
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.setAsrLoaded(false).catch(() => undefined);
    await this.setLlmLoaded(false, { force: true }).catch(() => undefined);
  }

  private async initNow(): Promise<PluginPlatformState> {
    try {
      if (!this.resolvedDataDir) {
        this.resolvedDataDir = await resolveAppDataDir();
      }
      await this.service.init();
      const allPlugins = await this.service.listValid();
      const nextAsr = await this.service.activePlugin("asr");
      const llmPlugins = allPlugins.filter((p) => p.kind === "llm");
      const nextLlm = await this.service.activePlugin("llm");

      if (this.activeAsr?.pluginId !== nextAsr?.pluginId && this.asrRuntime) {
        await this.asrRuntime.shutdown().catch(() => undefined);
        this.asrRuntime = null;
        this.asrReady = false;
      }
      if (this.activeLlm?.pluginId !== nextLlm?.pluginId && this.llmRuntime) {
        await this.llmRuntime.shutdown().catch(() => undefined);
        this.llmRuntime = null;
      }

      this.plugins = allPlugins;
      this.activeAsr = nextAsr;
      this.activeLlm = nextLlm;
      this.llmCount = llmPlugins.length;
      this.initError = null;
      this.initialized = true;

      await this.refreshLlmHealth();
      this.syncCapabilityStates();
      return this.snapshot();
    } catch (error) {
      this.plugins = [];
      this.activeAsr = null;
      this.activeLlm = null;
      this.llmCount = 0;
      this.llmHealth = null;
      this.asrReady = false;
      this.initError = toErrorMessage(error);
      this.initialized = true;
      this.syncCapabilityStates();
      return this.snapshot();
    }
  }

  private snapshot(): PluginPlatformState {
    const llmStatus = this.activeLlm
      ? (this.llmHealth?.message ?? "Service is stopped")
      : "unavailable";
    return {
      ready: this.initError === null,
      error: this.initError,
      canImport: this.canImport,
      features: {
        transcription: this.activeAsr != null,
        llm: this.activeLlm != null,
      },
      plugins: this.plugins,
      activeAsr: this.activeAsr,
      activeLlm: this.activeLlm,
      llmCount: this.llmCount,
      llmRunning: this.llmHealth?.running ?? false,
      llmStatus,
      llmEndpoint: this.llmHealth?.endpoint ?? null,
    };
  }

  private async ensureAsrRuntime(): Promise<RuntimeAdapter> {
    if (!this.activeAsr) {
      throw new Error("No active ASR provider configured");
    }
    if (!this.asrRuntime) {
      this.asrRuntime = createRuntimeAdapter(this.activeAsr, {
        workerUrl: this.options.workerUrl,
        ortDir: this.options.ortDir,
        appDataDir: this.resolvedDataDir,
        appOrigin: this.options.appOrigin,
        asrRuntimeConfig: this.options.asrRuntimeConfig,
        events: {
          onStatus: (message) => this.options.asrEvents.onStatus(message),
          onCrash: (message) => {
            this.asrReady = false;
            this.options.asrEvents.onCrash(message);
          },
        },
      });
    }
    return this.asrRuntime;
  }

  private async ensureLlmRuntime(): Promise<RuntimeAdapter> {
    if (!this.activeLlm) {
      throw new Error("No active LLM provider configured");
    }
    if (!this.llmRuntime) {
      this.llmRuntime = createRuntimeAdapter(this.activeLlm, {
        workerUrl: this.options.workerUrl,
        ortDir: this.options.ortDir,
        appDataDir: this.resolvedDataDir,
        appOrigin: this.options.appOrigin,
        asrRuntimeConfig: this.options.asrRuntimeConfig,
        events: {
          onStatus: () => undefined,
          onCrash: (message) => {
            console.error("LLM runtime crash reported:", message);
          },
        },
      });
    }
    return this.llmRuntime;
  }

  private startAsrSetLoadedLoop(): Promise<void> {
    const task = (async () => {
      while (this.asrTargetLoaded !== this.asrReady) {
        if (this.asrTargetLoaded) {
          this.asrLoadState = "loading";
          await this.loadAsr();
          continue;
        }

        if (!this.asrForceUnload && this.asrInFlightCount > 0) {
          this.asrLoadState = "loaded";
          await this.waitForAsrIdle();
          continue;
        }

        this.asrLoadState = "unloading";
        await this.unloadAsr();
      }
      this.asrLoadState = this.asrReady ? "loaded" : "unloaded";
      this.asrForceUnload = false;
    })()
      .catch((error) => {
        this.asrLoadState = this.asrReady ? "loaded" : "unloaded";
        const resolvers = this.asrIdleResolvers;
        this.asrIdleResolvers = [];
        for (const resolve of resolvers) resolve();
        throw error;
      })
      .finally(() => {
        if (this.asrSetLoadedTask === task) {
          this.asrSetLoadedTask = null;
        }
      });
    this.asrSetLoadedTask = task;
    return task;
  }

  private startLlmSetLoadedLoop(): Promise<void> {
    const task = (async () => {
      while (this.llmTargetLoaded !== this.isLlmRunning()) {
        if (this.llmTargetLoaded) {
          this.llmLoadState = "loading";
          await this.loadLlm();
          continue;
        }

        if (!this.llmForceUnload && this.llmInFlightCount > 0) {
          this.llmLoadState = "loaded";
          await this.waitForLlmIdle();
          continue;
        }

        this.llmLoadState = "unloading";
        await this.unloadLlm();
      }

      this.llmLoadState = this.isLlmRunning() ? "loaded" : "unloaded";
      this.llmForceUnload = false;
    })()
      .catch((error) => {
        this.llmLoadState = this.isLlmRunning() ? "loaded" : "unloaded";
        const resolvers = this.llmIdleResolvers;
        this.llmIdleResolvers = [];
        for (const resolve of resolvers) resolve();
        throw error;
      })
      .finally(() => {
        if (this.llmSetLoadedTask === task) {
          this.llmSetLoadedTask = null;
        }
      });
    this.llmSetLoadedTask = task;
    return task;
  }

  private async waitForLlmIdle(): Promise<void> {
    if (this.llmInFlightCount === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.llmIdleResolvers.push(resolve);
    });
  }

  private async waitForAsrIdle(): Promise<void> {
    if (this.asrInFlightCount === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.asrIdleResolvers.push(resolve);
    });
  }

  private isLlmRunning(): boolean {
    return this.llmHealth?.running ?? false;
  }

  private syncCapabilityStates(): void {
    if (!this.asrSetLoadedTask) {
      this.asrLoadState = this.asrReady ? "loaded" : "unloaded";
      if (!this.activeAsr) {
        this.asrTargetLoaded = false;
      }
    }

    if (!this.llmSetLoadedTask) {
      const running = this.isLlmRunning();
      this.llmLoadState = running ? "loaded" : "unloaded";
      if (!this.activeLlm) {
        this.llmTargetLoaded = false;
      }
    }
  }

  private async refreshLlmHealth(): Promise<void> {
    if (!this.activeLlm) {
      this.llmHealth = null;
      return;
    }

    try {
      this.llmHealth = await this.service.serviceStatus(
        this.activeLlm.pluginId,
      );
    } catch (error) {
      this.llmHealth = {
        ready: false,
        running: false,
        message: toErrorMessage(error),
        pid: null,
        endpoint: null,
      };
    }
  }
}
