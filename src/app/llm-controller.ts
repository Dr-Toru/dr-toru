import type { PluginPlatform, PluginPlatformState } from "../plugins";

export interface LlmControllerOptions {
  pluginPlatform: PluginPlatform;
  onStatus: (message: string) => void;
  onOutput: (text: string) => void;
  onStateChange: (state: PluginPlatformState) => void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LlmController {
  private readonly platform: PluginPlatform;
  private readonly onStatus: (message: string) => void;
  private readonly onOutput: (text: string) => void;
  private readonly onStateChange: (state: PluginPlatformState) => void;
  private state: PluginPlatformState | null = null;

  constructor(options: LlmControllerOptions) {
    this.platform = options.pluginPlatform;
    this.onStatus = options.onStatus;
    this.onOutput = options.onOutput;
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

    try {
      this.state = await this.platform.setLlmServiceRunning(running);
    } catch (error) {
      this.onStatus(`LLM service: ${toErrorMessage(error)}`);
    }

    this.state = await this.platform.status();
    this.onStateChange(this.state);
    return this.state;
  }

  async runWithPrompt(systemPrompt: string, input: string): Promise<string> {
    if (!this.state?.activeLlm) {
      throw new Error("No active LLM provider");
    }
    if (!this.state.llmRunning) {
      throw new Error("Start the LLM service first");
    }
    if (!input.trim()) {
      throw new Error("No input text provided");
    }

    const text = await this.platform.runLlm(
      "generate",
      input.trim(),
      systemPrompt,
    );
    this.state = await this.platform.status();
    this.onStateChange(this.state);
    return text;
  }

  async run(input: string, action = "correct"): Promise<void> {
    if (!this.state?.activeLlm) {
      this.onOutput("(No active LLM provider)");
      return;
    }
    if (!this.state.llmRunning) {
      this.onOutput("(Start the LLM service first)");
      return;
    }
    if (!input.trim()) {
      this.onOutput("(Enter text to process)");
      return;
    }

    this.onOutput("Running LLM...");
    try {
      const text = await this.platform.runLlm(action, input.trim());
      this.onOutput(text || "(No output returned)");
    } catch (error) {
      this.onOutput(`LLM failed: ${toErrorMessage(error)}`);
    }

    this.state = await this.platform.status();
    this.onStateChange(this.state);
  }
}
