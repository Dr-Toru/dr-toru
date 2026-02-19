import type { PluginPlatform, PluginPlatformState } from "../plugins";

export interface LlmControllerOptions {
  pluginPlatform: PluginPlatform;
  onStatus: (message: string) => void;
  onStateChange: (state: PluginPlatformState) => void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LlmController {
  private readonly platform: PluginPlatform;
  private readonly onStatus: (message: string) => void;
  private readonly onStateChange: (state: PluginPlatformState) => void;
  private state: PluginPlatformState | null = null;

  constructor(options: LlmControllerOptions) {
    this.platform = options.pluginPlatform;
    this.onStatus = options.onStatus;
    this.onStateChange = options.onStateChange;
  }

  setState(state: PluginPlatformState): void {
    this.state = state;
  }

  isReady(): boolean {
    return Boolean(this.state?.features.llm);
  }

  isRunning(): boolean {
    return this.state?.llmRunning ?? false;
  }

  async setServiceRunning(running: boolean): Promise<PluginPlatformState> {
    if (!this.state?.activeLlm) {
      throw new Error("No active LLM provider configured");
    }

    let startError: string | null = null;
    try {
      this.state = await this.platform.setLlmServiceRunning(running);
    } catch (error) {
      startError = toErrorMessage(error);
    }

    this.state = await this.platform.status();
    this.onStateChange(this.state);
    if (startError) {
      this.onStatus(`LLM service error: ${startError}`);
    }
    return this.state;
  }
}
