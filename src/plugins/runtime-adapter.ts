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
  assetBaseUrl: string;
  ortDir: string;
  events: AsrClientEvents;
}

export function createRuntimeAdapter(
  manifest: PluginManifest,
  options: RuntimeFactoryOptions,
): RuntimeAdapter {
  if (manifest.runtime === "ort") {
    const modelUrl = resolveAssetUrl(
      manifest.entrypointPath,
      options.assetBaseUrl,
    );
    const vocabPath = getMetadataString(manifest, "vocabPath");
    if (!vocabPath) {
      throw new Error(
        `ASR plugin ${manifest.pluginId} is missing metadata.vocabPath`,
      );
    }
    const vocabUrl = resolveAssetUrl(vocabPath, options.assetBaseUrl);

    return new OrtRuntimeAdapter(
      manifest,
      new AsrClient(options.workerUrl, options.events),
      modelUrl,
      vocabUrl,
      options.ortDir,
    );
  }

  return new LlamafileRuntimeAdapter(manifest.pluginId);
}

class OrtRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly asrClient: AsrClient,
    private readonly modelUrl: string,
    private readonly vocabUrl: string,
    private readonly ortDir: string,
  ) {}

  async init(): Promise<void> {
    await this.asrClient.load(this.modelUrl, this.vocabUrl, this.ortDir);
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

function getMetadataString(
  manifest: PluginManifest,
  key: string,
): string | null {
  const value = manifest.metadata?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function resolveAssetUrl(path: string, assetBaseUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path;
  }
  return new URL(path, assetBaseUrl).href;
}
