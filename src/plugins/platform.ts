import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import type { AsrClientEvents } from "../asr/client";
import type { PluginCapability, PluginManifest } from "./contracts";
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
  assetBaseUrl: string;
  ortDir: string;
  asrEvents: AsrClientEvents;
}

export interface PluginPlatformState {
  ready: boolean;
  error: string | null;
  canImport: boolean;
  activeAsr: PluginManifest | null;
  activeTransform: PluginManifest | null;
  transformCount: number;
  transformRunning: boolean;
  transformStatus: string;
  transformEndpoint: string | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickTransformCapability(
  plugin: PluginManifest,
): PluginCapability | null {
  if (plugin.capabilities.includes("llm.transform.correct")) {
    return "llm.transform.correct";
  }
  if (plugin.capabilities.includes("llm.transform.soap")) {
    return "llm.transform.soap";
  }
  return null;
}

export function formatPluginSummary(state: PluginPlatformState): string {
  if (!state.ready && state.error) {
    return `Plugin platform error: ${state.error}`;
  }

  const lines: string[] = [];
  if (state.activeAsr) {
    lines.push(`ASR: ${state.activeAsr.name} (${state.activeAsr.runtime})`);
  } else {
    lines.push("ASR: none configured");
  }

  if (state.activeTransform) {
    lines.push(
      `Transform: ${state.activeTransform.name} (${state.activeTransform.runtime})`,
    );
  } else if (state.transformCount > 0) {
    lines.push(`Transform: ${state.transformCount} installed, none active`);
  } else {
    lines.push("Transform: unavailable (core dictation only)");
  }
  return lines.join(" | ");
}

export function formatTransformStatus(state: PluginPlatformState): string {
  if (!state.activeTransform) {
    return "Transform service: unavailable";
  }
  if (state.transformEndpoint) {
    return `Transform service: ${state.transformStatus} (${state.transformEndpoint})`;
  }
  return `Transform service: ${state.transformStatus}`;
}

export class PluginPlatform {
  private readonly service: PluginService;
  private readonly canImport = canUseTauriPluginStore();
  private initTask: Promise<PluginPlatformState> | null = null;
  private initError: string | null = null;
  private activeAsr: PluginManifest | null = null;
  private activeTransform: PluginManifest | null = null;
  private transformCount = 0;
  private transformHealth: PluginServiceHealth | null = null;
  private asrRuntime: RuntimeAdapter | null = null;
  private transformRuntime: RuntimeAdapter | null = null;
  private asrReady = false;

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
    } else if (!this.activeAsr && !this.initError) {
      await this.init();
    } else {
      await this.refreshTransformHealth();
    }
    return this.snapshot();
  }

  async pickImportPath(): Promise<string | null> {
    if (!this.canImport) {
      return null;
    }

    const sourcePath = await openFileDialog({
      title: "Import Model File",
      multiple: false,
      filters: [{ name: "Model Files", extensions: ["llamafile", "onnx"] }],
    });
    if (typeof sourcePath !== "string") {
      return null;
    }
    return sourcePath;
  }

  async importFromPath(request: PluginImportRequest): Promise<PluginManifest> {
    const state = await this.init();
    if (!state.ready) {
      throw new Error(state.error ?? "Plugin platform is unavailable");
    }
    const imported = await this.service.importFromPath(request);
    await this.init();
    return imported;
  }

  async loadAsr(): Promise<PluginManifest> {
    const state = await this.init();
    if (!state.ready) {
      throw new Error(state.error ?? "Plugin platform is unavailable");
    }

    const runtime = await this.ensureAsrRuntime();
    await runtime.init();
    const health = await runtime.health();
    if (!health.ready) {
      this.asrReady = false;
      throw new Error(health.message);
    }
    this.asrReady = true;
    return this.activeAsr as PluginManifest;
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

  async setTransformServiceRunning(
    running: boolean,
  ): Promise<PluginPlatformState> {
    const state = await this.init();
    if (!state.ready) {
      throw new Error(state.error ?? "Plugin platform is unavailable");
    }
    if (!this.activeTransform) {
      throw new Error("No active transform provider configured");
    }

    try {
      if (running) {
        const runtime = await this.ensureTransformRuntime();
        await runtime.init();
      } else {
        await this.transformRuntime?.shutdown();
      }
    } finally {
      await this.refreshTransformHealth();
    }

    return this.snapshot();
  }

  async runTransform(input: string, prompt?: string): Promise<string> {
    const state = await this.init();
    if (!state.ready) {
      throw new Error(state.error ?? "Plugin platform is unavailable");
    }
    if (!this.activeTransform) {
      throw new Error("No active transform provider configured");
    }

    const capability = pickTransformCapability(this.activeTransform);
    if (!capability) {
      throw new Error("Active transform plugin has no supported capability");
    }
    if (!this.transformHealth?.running) {
      throw new Error("Start the transform service first");
    }

    try {
      const runtime = await this.ensureTransformRuntime();
      const result = await runtime.execute({
        type: "llm.transform",
        capability,
        input,
        prompt,
      });
      return result.text;
    } catch (error) {
      await this.refreshTransformHealth();
      throw new Error(toErrorMessage(error));
    }
  }

  async shutdown(): Promise<void> {
    this.asrReady = false;
    await this.asrRuntime?.shutdown().catch(() => undefined);
    await this.transformRuntime?.shutdown().catch(() => undefined);
    this.asrRuntime = null;
    this.transformRuntime = null;
    this.transformHealth = null;
  }

  private async initNow(): Promise<PluginPlatformState> {
    try {
      await this.service.init();
      const nextAsr = await this.service.activePlugin("asr");
      const transforms = await this.service.discover({ role: "transform" });
      const nextTransform = await this.service.activePlugin("transform");

      if (this.activeAsr?.pluginId !== nextAsr?.pluginId && this.asrRuntime) {
        await this.asrRuntime.shutdown().catch(() => undefined);
        this.asrRuntime = null;
        this.asrReady = false;
      }
      if (
        this.activeTransform?.pluginId !== nextTransform?.pluginId &&
        this.transformRuntime
      ) {
        await this.transformRuntime.shutdown().catch(() => undefined);
        this.transformRuntime = null;
      }

      this.activeAsr = nextAsr;
      this.activeTransform = nextTransform;
      this.transformCount = transforms.length;
      this.initError = null;

      await this.refreshTransformHealth();
      return this.snapshot();
    } catch (error) {
      this.activeAsr = null;
      this.activeTransform = null;
      this.transformCount = 0;
      this.transformHealth = null;
      this.asrReady = false;
      this.initError = toErrorMessage(error);
      return this.snapshot();
    }
  }

  private snapshot(): PluginPlatformState {
    const transformStatus = this.activeTransform
      ? (this.transformHealth?.message ?? "Service is stopped")
      : "unavailable";
    return {
      ready: this.initError === null && this.activeAsr !== null,
      error: this.initError,
      canImport: this.canImport,
      activeAsr: this.activeAsr,
      activeTransform: this.activeTransform,
      transformCount: this.transformCount,
      transformRunning: this.transformHealth?.running ?? false,
      transformStatus,
      transformEndpoint: this.transformHealth?.endpoint ?? null,
    };
  }

  private async ensureAsrRuntime(): Promise<RuntimeAdapter> {
    if (!this.activeAsr) {
      throw new Error("No active ASR provider configured");
    }
    if (!this.asrRuntime) {
      this.asrRuntime = createRuntimeAdapter(this.activeAsr, {
        workerUrl: this.options.workerUrl,
        assetBaseUrl: this.options.assetBaseUrl,
        ortDir: this.options.ortDir,
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

  private async ensureTransformRuntime(): Promise<RuntimeAdapter> {
    if (!this.activeTransform) {
      throw new Error("No active transform provider configured");
    }
    if (!this.transformRuntime) {
      this.transformRuntime = createRuntimeAdapter(this.activeTransform, {
        workerUrl: this.options.workerUrl,
        assetBaseUrl: this.options.assetBaseUrl,
        ortDir: this.options.ortDir,
        events: {
          onStatus: () => undefined,
          onCrash: (message) => {
            console.error("Transform runtime crash reported:", message);
          },
        },
      });
    }
    return this.transformRuntime;
  }

  private async refreshTransformHealth(): Promise<void> {
    if (!this.activeTransform) {
      this.transformHealth = null;
      return;
    }

    try {
      this.transformHealth = await this.service.serviceStatus(
        this.activeTransform.pluginId,
      );
    } catch (error) {
      this.transformHealth = {
        ready: false,
        running: false,
        message: toErrorMessage(error),
        pid: null,
        endpoint: null,
      };
    }
  }
}
