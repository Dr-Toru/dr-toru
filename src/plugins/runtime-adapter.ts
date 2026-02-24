import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";

import { AsrClient, type AsrClientEvents } from "../asr/client";
import type { AsrRuntimeConfig } from "../asr-messages";
import type { PluginManifest } from "./contracts";

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
      action: string;
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
  ortDir: string;
  appDataDir: string;
  /** Absolute URL for the webview origin (e.g. "https://tauri.localhost/"). */
  appOrigin: string;
  events: AsrClientEvents;
  asrRuntimeConfig: AsrRuntimeConfig;
}

// Resolve manifest asset paths to absolute URLs suitable for fetch()
// inside a web worker (where relative URLs resolve against the worker
// script, not the app origin).
//
// Absolute filesystem paths and paths under "plugins/" are converted
// to Tauri asset-protocol URLs. The "plugins/" prefix mirrors the
// layout used by Rust copy_imported_asset().
//
// All other paths (e.g. builtin "models/...") are resolved against
// the webview origin so the worker fetches from the correct location.
function resolveAssetUrl(
  manifestPath: string,
  appDataDir: string,
  appOrigin: string,
): string {
  if (manifestPath.startsWith("/")) {
    return convertFileSrc(manifestPath);
  }
  if (appDataDir && manifestPath.startsWith("plugins/")) {
    const base = appDataDir.endsWith("/") ? appDataDir : appDataDir + "/";
    return convertFileSrc(base + manifestPath);
  }
  // Resolve relative paths against the app origin so they work inside
  // the web worker, where bare relative fetches would resolve against
  // the worker script URL instead.
  return new URL(manifestPath, appOrigin).href;
}

export function createRuntimeAdapter(
  manifest: PluginManifest,
  options: RuntimeFactoryOptions,
): RuntimeAdapter {
  switch (manifest.kind) {
    case "asr": {
      if (manifest.runtime !== "ort-ctc" && manifest.runtime !== "whisper") {
        throw new Error(
          `Unsupported ASR runtime "${manifest.runtime}" for ${manifest.pluginId}`,
        );
      }
      const vocabPath = manifest.metadata?.vocabPath;
      if (
        manifest.runtime === "ort-ctc" &&
        (typeof vocabPath !== "string" || !vocabPath.trim())
      ) {
        throw new Error(
          `Plugin ${manifest.pluginId} is missing metadata.vocabPath`,
        );
      }
      if (isTauri()) {
        return new NativeAsrRuntimeAdapter(manifest.pluginId, options.events);
      }
      if (manifest.runtime !== "ort-ctc") {
        throw new Error(
          `Runtime ${manifest.runtime} is only supported in native desktop mode`,
        );
      }
      return new OrtRuntimeAdapter(
        manifest,
        new AsrClient(options.workerUrl, options.events),
        options.ortDir,
        options.appDataDir,
        options.appOrigin,
        options.asrRuntimeConfig,
      );
    }
    case "llm":
      if (manifest.runtime !== "llamafile") {
        throw new Error(
          `Unsupported LLM runtime "${manifest.runtime}" for ${manifest.pluginId}`,
        );
      }
      return new LlamafileRuntimeAdapter(manifest.pluginId);
    default:
      throw new Error(
        `Unsupported plugin kind "${manifest.kind}" for ${manifest.pluginId}`,
      );
  }
}

class OrtRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly asrClient: AsrClient,
    private readonly ortDir: string,
    private readonly appDataDir: string,
    private readonly appOrigin: string,
    private readonly asrRuntimeConfig: AsrRuntimeConfig,
  ) {}

  async init(): Promise<void> {
    const vocabPath = this.manifest.metadata?.vocabPath as string;
    const modelUrl = resolveAssetUrl(
      this.manifest.entrypointPath,
      this.appDataDir,
      this.appOrigin,
    );
    const vocabUrl = resolveAssetUrl(
      vocabPath,
      this.appDataDir,
      this.appOrigin,
    );

    const lmPath = this.manifest.metadata?.lmPath;
    const kenlmWasmPath = this.manifest.metadata?.kenlmWasmPath;

    let lmUrl: string | undefined;
    let kenlmDir: string | undefined;
    if (typeof lmPath === "string" && lmPath.trim()) {
      lmUrl = resolveAssetUrl(lmPath, this.appDataDir, this.appOrigin);
    }
    if (typeof kenlmWasmPath === "string" && kenlmWasmPath.trim()) {
      const resolved = resolveAssetUrl(
        kenlmWasmPath,
        this.appDataDir,
        this.appOrigin,
      );
      kenlmDir = resolved.replace(/[^/]+$/, "");
    }

    await this.asrClient.load(
      modelUrl,
      vocabUrl,
      this.ortDir,
      lmUrl,
      kenlmDir,
      this.asrRuntimeConfig,
    );
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
    await this.asrClient.shutdown();
  }
}

class NativeAsrRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly pluginId: string,
    private readonly events: AsrClientEvents,
  ) {}

  async init(): Promise<void> {
    this.events.onStatus("Loading native ASR model...");
    await invoke<void>("plugin_asr_load", { pluginId: this.pluginId });
    this.events.onStatus("Native ASR model loaded");
  }

  async health(): Promise<RuntimeHealth> {
    return { ready: true, message: "Native ASR ready" };
  }

  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResult> {
    if (request.type !== "asr.transcribe") {
      throw new Error(
        `Native ASR runtime does not support request ${request.type}`,
      );
    }
    return invoke<RuntimeExecuteResult>("plugin_asr_transcribe", {
      pluginId: this.pluginId,
      samples: Array.from(request.samples),
    });
  }

  async shutdown(): Promise<void> {
    await invoke<void>("plugin_asr_unload", { pluginId: this.pluginId });
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
      action: request.action,
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
