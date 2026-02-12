import type {
  LoadRequest,
  MainToWorkerMessage,
  TranscribeRequest,
  WorkerToMainMessage,
} from "../asr-messages";

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface AsrClientEvents {
  onStatus: (message: string) => void;
  onCrash: (message: string) => void;
}

export class AsrClient {
  private worker: Worker | null = null;
  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private loadPromise: Promise<void> | null = null;
  private nextRequestId = 0;
  private pending = new Map<number, PendingRequest>();
  private readyValue = false;

  constructor(
    private readonly workerUrl: URL,
    private readonly events: AsrClientEvents,
  ) {}

  get ready(): boolean {
    return this.readyValue;
  }

  async load(modelsDir: string, ortDir: string): Promise<void> {
    if (this.readyValue) {
      return;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const target = this.ensureWorker();
    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
      const message: LoadRequest = { type: "load", modelsDir, ortDir };
      target.postMessage(message satisfies MainToWorkerMessage);
    });

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
      this.loadResolve = null;
      this.loadReject = null;
    }
  }

  transcribe(samples: Float32Array): Promise<string> {
    const target = this.ensureWorker();
    this.nextRequestId += 1;
    const id = this.nextRequestId;

    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: TranscribeRequest = {
        type: "transcribe",
        requestId: id,
        samples,
      };
      target.postMessage(message satisfies MainToWorkerMessage, [samples.buffer]);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.readyValue = false;
    this.rejectAll("Client terminated");
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.addEventListener("message", (e) => this.onMessage(e));
    this.worker.addEventListener("error", (e) => this.onError(e));
    return this.worker;
  }

  private onMessage(event: MessageEvent<WorkerToMainMessage>): void {
    const msg = event.data;

    if (msg.type === "status") {
      this.events.onStatus(msg.message);
      return;
    }

    if (msg.type === "load-success") {
      this.readyValue = true;
      this.loadResolve?.();
      return;
    }

    if (msg.type === "load-error") {
      this.readyValue = false;
      this.loadReject?.(new Error(msg.message));
      return;
    }

    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.requestId);

    if (msg.type === "transcribe-success") {
      pending.resolve(msg.text);
      return;
    }

    pending.reject(new Error(msg.message));
  }

  private onError(event: ErrorEvent): void {
    const message = event.message || "Worker crashed";
    this.readyValue = false;

    this.loadReject?.(new Error(message));
    this.loadReject = null;
    this.loadResolve = null;

    this.rejectAll(message);

    this.worker?.terminate();
    this.worker = null;

    this.events.onCrash(message);
  }

  private rejectAll(reason: string): void {
    for (const req of this.pending.values()) {
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
