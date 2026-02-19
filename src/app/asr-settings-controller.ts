import {
  sanitizeAsrSettings,
  writeAsrSettings,
  type AsrSettings,
} from "../asr/settings";

export interface AsrSettingsControllerOptions {
  isRecording: () => boolean;
  onError: (error: unknown, context: string) => void;
}

export class AsrSettingsController {
  private readonly isRecording: () => boolean;
  private readonly onError: (error: unknown, context: string) => void;

  private readonly saveBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly asrEnabledInput: HTMLInputElement;
  private readonly beamSearchEnabledInput: HTMLInputElement;
  private readonly chunkSecsInput: HTMLInputElement;
  private readonly strideSecsInput: HTMLInputElement;
  private readonly silenceRmsInput: HTMLInputElement;
  private readonly silencePeakInput: HTMLInputElement;
  private readonly silenceHoldInput: HTMLInputElement;
  private readonly silenceProbeInput: HTMLInputElement;
  private readonly ortThreadsInput: HTMLInputElement;
  private readonly beamWidthInput: HTMLInputElement;
  private readonly lmAlphaInput: HTMLInputElement;
  private readonly lmBetaInput: HTMLInputElement;
  private readonly minTokenLogpInput: HTMLInputElement;
  private readonly beamPruneLogpInput: HTMLInputElement;

  constructor(options: AsrSettingsControllerOptions) {
    this.isRecording = options.isRecording;
    this.onError = options.onError;

    this.saveBtn = mustBtn("saveAsrSettingsBtn");
    this.statusEl = mustEl("asrSettingsStatus");
    this.asrEnabledInput = mustInput("asrEnabled");
    this.beamSearchEnabledInput = mustInput("asrBeamSearchEnabled");
    this.chunkSecsInput = mustInput("asrChunkSecs");
    this.strideSecsInput = mustInput("asrStrideSecs");
    this.silenceRmsInput = mustInput("asrSilenceRms");
    this.silencePeakInput = mustInput("asrSilencePeak");
    this.silenceHoldInput = mustInput("asrSilenceHoldChunks");
    this.silenceProbeInput = mustInput("asrSilenceProbeEvery");
    this.ortThreadsInput = mustInput("asrOrtThreads");
    this.beamWidthInput = mustInput("asrBeamWidth");
    this.lmAlphaInput = mustInput("asrLmAlpha");
    this.lmBetaInput = mustInput("asrLmBeta");
    this.minTokenLogpInput = mustInput("asrMinTokenLogp");
    this.beamPruneLogpInput = mustInput("asrBeamPruneLogp");

    this.asrEnabledInput.addEventListener("change", () => {
      this.updateFieldState();
    });
    this.beamSearchEnabledInput.addEventListener("change", () => {
      this.updateFieldState();
    });
    this.saveBtn.addEventListener("click", () => {
      this.save();
    });
  }

  populate(settings: AsrSettings): void {
    this.asrEnabledInput.checked = settings.asrEnabled;
    this.beamSearchEnabledInput.checked =
      settings.runtimeConfig.decode.beamSearchEnabled;
    this.chunkSecsInput.value = String(settings.chunkSecs);
    this.strideSecsInput.value = String(settings.strideSecs);
    this.silenceRmsInput.value = String(settings.silenceRms);
    this.silencePeakInput.value = String(settings.silencePeak);
    this.silenceHoldInput.value = String(settings.silenceHoldChunks);
    this.silenceProbeInput.value = String(settings.silenceProbeEvery);
    this.ortThreadsInput.value = String(settings.runtimeConfig.ortThreads);
    this.beamWidthInput.value = String(settings.runtimeConfig.decode.beamWidth);
    this.lmAlphaInput.value = String(settings.runtimeConfig.decode.lmAlpha);
    this.lmBetaInput.value = String(settings.runtimeConfig.decode.lmBeta);
    this.minTokenLogpInput.value = String(
      settings.runtimeConfig.decode.minTokenLogp,
    );
    this.beamPruneLogpInput.value = String(
      settings.runtimeConfig.decode.beamPruneLogp,
    );
    this.updateFieldState();
    this.statusEl.textContent =
      "Tune ASR values here. Saving reloads the app and applies new settings.";
  }

  private save(): void {
    if (this.isRecording()) {
      this.statusEl.textContent = "Stop recording before saving ASR settings.";
      return;
    }

    try {
      const next = sanitizeAsrSettings({
        asrEnabled: this.asrEnabledInput.checked,
        chunkSecs: this.chunkSecsInput.valueAsNumber,
        strideSecs: this.strideSecsInput.valueAsNumber,
        silenceRms: this.silenceRmsInput.valueAsNumber,
        silencePeak: this.silencePeakInput.valueAsNumber,
        silenceHoldChunks: this.silenceHoldInput.valueAsNumber,
        silenceProbeEvery: this.silenceProbeInput.valueAsNumber,
        runtimeConfig: {
          ortThreads: this.ortThreadsInput.valueAsNumber,
          decode: {
            beamSearchEnabled: this.beamSearchEnabledInput.checked,
            beamWidth: this.beamWidthInput.valueAsNumber,
            lmAlpha: this.lmAlphaInput.valueAsNumber,
            lmBeta: this.lmBetaInput.valueAsNumber,
            minTokenLogp: this.minTokenLogpInput.valueAsNumber,
            beamPruneLogp: this.beamPruneLogpInput.valueAsNumber,
          },
        },
      });

      writeAsrSettings(next);
      this.populate(next);
      this.statusEl.textContent =
        "ASR settings saved. Reloading to apply updated runtime settings...";
      window.setTimeout(() => {
        window.location.reload();
      }, 150);
    } catch (error) {
      this.onError(error, "Failed to save ASR settings");
    }
  }

  private updateFieldState(): void {
    const asrEnabled = this.asrEnabledInput.checked;
    const beamEnabled = this.beamSearchEnabledInput.checked;

    this.beamSearchEnabledInput.disabled = !asrEnabled;
    this.chunkSecsInput.disabled = !asrEnabled;
    this.strideSecsInput.disabled = !asrEnabled;
    this.silenceRmsInput.disabled = !asrEnabled;
    this.silencePeakInput.disabled = !asrEnabled;
    this.silenceHoldInput.disabled = !asrEnabled;
    this.silenceProbeInput.disabled = !asrEnabled;
    this.ortThreadsInput.disabled = !asrEnabled;

    const decodeEnabled = asrEnabled && beamEnabled;
    this.beamWidthInput.disabled = !decodeEnabled;
    this.lmAlphaInput.disabled = !decodeEnabled;
    this.lmBetaInput.disabled = !decodeEnabled;
    this.minTokenLogpInput.disabled = !decodeEnabled;
    this.beamPruneLogpInput.disabled = !decodeEnabled;
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

function mustInput(id: string): HTMLInputElement {
  const el = mustEl(id);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return el;
}
