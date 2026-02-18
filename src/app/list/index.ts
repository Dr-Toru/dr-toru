import type { RecordingSummary } from "../../domain/recording";
import type { RecordingStore } from "../../storage/store";

export const RECORDINGS_CHANGED_EVENT = "toru:recordings-changed";

export interface ListControllerOptions {
  container: HTMLElement;
  store: RecordingStore;
  onSelect?: (recordingId: string) => void;
}

export class ListController {
  private readonly container: HTMLElement;
  private readonly store: RecordingStore;
  private readonly onSelect: (recordingId: string) => void;
  private listening = false;
  private refreshSeq = 0;
  private readonly onChanged = (): void => {
    void this.refresh();
  };

  constructor(options: ListControllerOptions) {
    this.container = options.container;
    this.store = options.store;
    this.onSelect = options.onSelect ?? (() => undefined);
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
    const seq = ++this.refreshSeq;

    let summaries: RecordingSummary[];
    try {
      summaries = await this.store.listRecordings();
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      this.container.textContent = `Failed to load recordings: ${message}`;
      return;
    }

    if (seq !== this.refreshSeq) return;

    if (summaries.length === 0) {
      this.container.replaceChildren(renderEmptyState());
      return;
    }

    this.container.replaceChildren(
      ...summaries.map((summary) => renderItem(summary, this.onSelect)),
    );
  }
}

function renderItem(
  summary: RecordingSummary,
  onSelect: (recordingId: string) => void,
): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "recording-item";
  el.dataset.recordingId = summary.recordingId;
  el.addEventListener("click", () => {
    onSelect(summary.recordingId);
  });

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

function renderEmptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><p>No sessions yet</p><p>Open a new session to get started</p>`;
  return el;
}

export function fireRecordingsChanged(): void {
  document.dispatchEvent(new CustomEvent(RECORDINGS_CHANGED_EVENT));
}
