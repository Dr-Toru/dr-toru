export type QueueJobStatus = "queued" | "running" | "completed" | "error";

export interface QueueJobState {
  queue: string;
  jobId: number;
  status: QueueJobStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

type QueueTask<T> = () => Promise<T> | T;

export interface EnqueueOptions {
  onStatus?: (state: QueueJobState) => void;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private nextJobId = 0;
  private pendingCountValue = 0;
  private activeCountValue = 0;

  constructor(private readonly queueName: string) {}

  get pendingCount(): number {
    return this.pendingCountValue;
  }

  get activeCount(): number {
    return this.activeCountValue;
  }

  get depth(): number {
    return this.pendingCountValue + this.activeCountValue;
  }

  enqueue<T>(task: QueueTask<T>, options: EnqueueOptions = {}): Promise<T> {
    const jobId = ++this.nextJobId;
    const queuedAt = performance.now();
    const emit = (state: QueueJobState): void => {
      options.onStatus?.(state);
    };

    this.pendingCountValue += 1;
    emit({
      queue: this.queueName,
      jobId,
      status: "queued",
      queuedAt,
    });

    const run = async (): Promise<T> => {
      this.pendingCountValue = Math.max(0, this.pendingCountValue - 1);
      this.activeCountValue += 1;
      const startedAt = performance.now();
      emit({
        queue: this.queueName,
        jobId,
        status: "running",
        queuedAt,
        startedAt,
      });

      try {
        const result = await task();
        emit({
          queue: this.queueName,
          jobId,
          status: "completed",
          queuedAt,
          startedAt,
          completedAt: performance.now(),
        });
        return result;
      } catch (error) {
        emit({
          queue: this.queueName,
          jobId,
          status: "error",
          queuedAt,
          startedAt,
          completedAt: performance.now(),
          error: toErrorMessage(error),
        });
        throw error;
      } finally {
        this.activeCountValue = Math.max(0, this.activeCountValue - 1);
      }
    };

    const result = this.tail.catch(() => undefined).then(run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  waitForIdle(): Promise<void> {
    return (async () => {
      while (true) {
        const snapshot = this.tail;
        await snapshot;
        if (
          snapshot === this.tail &&
          this.pendingCountValue === 0 &&
          this.activeCountValue === 0
        ) {
          return;
        }
      }
    })();
  }
}
