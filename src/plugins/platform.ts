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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatPluginSummary(state: PluginPlatformState): string {
  if (state.error) {
    return `Plugin platform error: ${state.error}`;
  }

  const lines: string[] = [];
  if (state.activeAsr) {
    lines.push(`ASR: ${state.activeAsr.name}`);
  } else {
    lines.push("ASR: none configured");
  }

  if (state.activeLlm) {
    lines.push(`LLM: ${state.activeLlm.name}`);
  } else if (state.llmCount > 0) {
    lines.push(`LLM: ${state.llmCount} installed, none active`);
  } else {
    lines.push("LLM: unavailable (core dictation only)");
  }
  return lines.join(" | ");
}

export function formatLlmStatus(state: PluginPlatformState): string {
  if (!state.activeLlm) {
    return "LLM service: unavailable";
  }
  if (state.llmEndpoint) {
    return `LLM service: ${state.llmStatus} (${state.llmEndpoint})`;
  }
  return `LLM service: ${state.llmStatus}`;
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

  constructor(
    store: PluginRegistryStore,
    private readonly options: PluginPlatformOptions,
  ) {
    this.service = new PluginService(store);
  }

  isAsrReady(): boolean {
    return this.asrReady;
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
      filters: [
        { name: "Model Files", extensions: ["llamafile", "onnx", "asrpkg"] },
      ],
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
    const result = await this.asrRuntime.execute({
      type: "asr.transcribe",
      samples,
    });
    return result.text;
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

  async setLlmServiceRunning(running: boolean): Promise<PluginPlatformState> {
    const state = await this.init();
    if (state.error) {
      throw new Error(state.error);
    }
    if (!this.activeLlm) {
      throw new Error("No active LLM provider configured");
    }

    try {
      if (running) {
        const runtime = await this.ensureLlmRuntime();
        await runtime.init();
      } else {
        await this.llmRuntime?.shutdown();
      }
    } finally {
      await this.refreshLlmHealth();
    }

    return this.snapshot();
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

    try {
      const runtime = await this.ensureLlmRuntime();
      const result = await runtime.execute({
        type: "llm.transform",
        action,
        input,
        prompt,
      });
      return result.text;
    } catch (error) {
      await this.refreshLlmHealth();
      throw new Error(toErrorMessage(error));
    }
  }

  async shutdown(): Promise<void> {
    await this.unloadAsr().catch(() => undefined);
    await this.llmRuntime?.shutdown().catch(() => undefined);
    this.llmRuntime = null;
    this.llmHealth = null;
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
