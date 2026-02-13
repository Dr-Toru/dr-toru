export interface LoadRequest {
  type: "load";
  modelUrl: string;
  vocabUrl: string;
  ortDir: string;
}

export interface TranscribeRequest {
  type: "transcribe";
  requestId: number;
  samples: Float32Array;
}

export type MainToWorkerMessage = LoadRequest | TranscribeRequest;

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

export type WorkerToMainMessage =
  | StatusMessage
  | LoadSuccessMessage
  | LoadErrorMessage
  | TranscribeSuccessMessage
  | TranscribeErrorMessage;
