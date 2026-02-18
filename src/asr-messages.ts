export interface AsrDecodeConfig {
  beamSearchEnabled: boolean;
  beamWidth: number;
  lmAlpha: number;
  lmBeta: number;
  minTokenLogp: number;
  beamPruneLogp: number;
}

export interface AsrRuntimeConfig {
  ortThreads: number;
  decode: AsrDecodeConfig;
}

export interface LoadRequest {
  type: "load";
  modelUrl: string;
  vocabUrl: string;
  ortDir: string;
  kenlmDir?: string;
  lmUrl?: string;
  runtimeConfig?: AsrRuntimeConfig;
}

export interface TranscribeRequest {
  type: "transcribe";
  requestId: number;
  samples: Float32Array;
}

export interface ShutdownRequest {
  type: "shutdown";
}

export type MainToWorkerMessage =
  | LoadRequest
  | TranscribeRequest
  | ShutdownRequest;

export interface StatusMessage {
  type: "status";
  message: string;
}

export interface LoadSuccessMessage {
  type: "load-success";
}

export interface LoadErrorMessage {
  type: "load-error";
  message: string;
}

export interface TranscribeSuccessMessage {
  type: "transcribe-success";
  requestId: number;
  text: string;
}

export interface TranscribeErrorMessage {
  type: "transcribe-error";
  requestId: number;
  message: string;
}

export interface ShutdownDoneMessage {
  type: "shutdown-done";
}

export type WorkerToMainMessage =
  | StatusMessage
  | LoadSuccessMessage
  | LoadErrorMessage
  | TranscribeSuccessMessage
  | TranscribeErrorMessage
  | ShutdownDoneMessage;
