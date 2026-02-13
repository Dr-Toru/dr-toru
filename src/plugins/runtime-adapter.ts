import { invoke } from "@tauri-apps/api/core";

import { AsrClient, type AsrClientEvents } from "../asr/client";
import type { PluginCapability, PluginManifest } from "./contracts";

export interface RuntimeHealth {
  ready: boolean;
  message: string;
}

export type RuntimeExecuteRequest =
  | {
      type: "asr.transcribe";
      samples: Float32Array;
    }
  | {
      type: "llm.transform";
      capability: PluginCapability;
      input: string;
      prompt?: string;
    };

export interface RuntimeExecuteResult {
  text: string;
}

export interface RuntimeAdapter {
  init(): Promise<void>;
  health(): Promise<RuntimeHealth>;
  execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResult>;
  shutdown(): Promise<void>;
}

export interface RuntimeFactoryOptions {
  workerUrl: URL;
  modelsDir: string;
  ortDir: string;
  events: AsrClientEvents;
}

export function createRuntimeAdapter(
  manifest: PluginManifest,
  options: RuntimeFactoryOptions,
): RuntimeAdapter {
  if (manifest.runtime === "ort") {
    return new OrtRuntimeAdapter(
      manifest,
      new AsrClient(options.workerUrl, options.events),
      options.modelsDir,
      options.ortDir,
    );
  }

  return new LlamafileRuntimeAdapter(manifest.pluginId);
}

class OrtRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly asrClient: AsrClient,
    private readonly modelsDir: string,
    private readonly ortDir: string,
  ) {}

  async init(): Promise<void> {
    await this.asrClient.load(this.modelsDir, this.ortDir);
  }

  async health(): Promise<RuntimeHealth> {
    return this.asrClient.ready
      ? {
          ready: true,
          message: `Ready (${this.manifest.name})`,
        }
      : {
          ready: false,
          message: `${this.manifest.name} is not loaded`,
        };
  }

  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResult> {
    if (request.type !== "asr.transcribe") {
      throw new Error(`ORT runtime does not support request ${request.type}`);
    }
    return { text: await this.asrClient.transcribe(request.samples) };
  }

  async shutdown(): Promise<void> {
    this.asrClient.terminate();
  }
}

interface LlamafileHealthResult {
  ready: boolean;
  message: string;
}

interface LlamafileExecuteResult {
  text: string;
}

class LlamafileRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly pluginId: string) {}

  init(): Promise<void> {
    return invoke<void>("plugin_service_start", {
      pluginId: this.pluginId,
    });
  }

  health(): Promise<RuntimeHealth> {
    return invoke<LlamafileHealthResult>("plugin_service_status", {
      pluginId: this.pluginId,
    });
  }

  execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResult> {
    if (request.type !== "llm.transform") {
      return Promise.reject(
        new Error(`Llamafile runtime does not support request ${request.type}`),
      );
    }
    return invoke<LlamafileExecuteResult>("plugin_runtime_llamafile_execute", {
      pluginId: this.pluginId,
      capability: request.capability,
      input: request.input,
      prompt: request.prompt ?? null,
    });
  }

  shutdown(): Promise<void> {
    return invoke<void>("plugin_service_stop", {
      pluginId: this.pluginId,
    });
  }
}
