import type { RecordingSummary } from "../../domain/recording";
import type { RecordingStore } from "../../storage/store";

export const RECORDINGS_CHANGED_EVENT = "toru:recordings-changed";

export interface ListControllerOptions {
  container: HTMLElement;
  store: RecordingStore;
}

export class ListController {
  private readonly container: HTMLElement;
  private readonly store: RecordingStore;
  private listening = false;
  private readonly onChanged = (): void => {
    void this.refresh();
  };

  constructor(options: ListControllerOptions) {
    this.container = options.container;
    this.store = options.store;
  }

  mount(): void {
    if (!this.listening) {
      document.addEventListener(RECORDINGS_CHANGED_EVENT, this.onChanged);
      this.listening = true;
    }
    void this.refresh();
  }

  unmount(): void {
    if (this.listening) {
      document.removeEventListener(RECORDINGS_CHANGED_EVENT, this.onChanged);
      this.listening = false;
    }
  }

  async refresh(): Promise<void> {
    let summaries: RecordingSummary[];
    try {
      summaries = await this.store.listRecordings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.container.textContent = `Failed to load recordings: ${message}`;
      return;
    }

    if (summaries.length === 0) {
      this.container.textContent = "No recordings yet.";
      return;
    }

    this.container.replaceChildren(...summaries.map(renderItem));
  }
}

function renderItem(summary: RecordingSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = "recording-item";
  el.dataset.recordingId = summary.recordingId;

  const date = document.createElement("span");
  date.className = "recording-date";
  date.textContent = formatDate(summary.createdAt);

  const count = document.createElement("span");
  count.className = "recording-attachment-count";
  const n = summary.attachmentCount;
  count.textContent = `${n} attachment${n === 1 ? "" : "s"}`;

  el.append(date, count);
  return el;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function fireRecordingsChanged(): void {
  document.dispatchEvent(new CustomEvent(RECORDINGS_CHANGED_EVENT));
}
