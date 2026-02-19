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
  private itemDisposers: Array<() => void> = [];
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
    this.teardownItems();
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;

    let summaries: RecordingSummary[];
    try {
      summaries = await this.store.listRecordings();
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      const message = error instanceof Error ? error.message : String(error);
      this.teardownItems();
      this.container.textContent = `Failed to load recordings: ${message}`;
      return;
    }

    if (seq !== this.refreshSeq) return;

    if (summaries.length === 0) {
      this.teardownItems();
      this.container.replaceChildren(renderEmptyState());
      return;
    }

    const rendered = summaries.map((summary) =>
      renderItem({
        summary,
        onSelect: this.onSelect,
        onDelete: (recordingId) => this.deleteRecording(recordingId),
      }),
    );

    this.teardownItems();
    this.itemDisposers = rendered.map((item) => item.dispose);
    this.container.replaceChildren(...rendered.map((item) => item.element));
  }

  private teardownItems(): void {
    for (const dispose of this.itemDisposers) {
      dispose();
    }
    this.itemDisposers = [];
  }

  private async deleteRecording(recordingId: string): Promise<void> {
    try {
      await this.store.deleteRecording(recordingId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to delete recording: ${message}`);
      return;
    }

    fireRecordingsChanged();
    if (!this.listening) {
      await this.refresh();
    }
  }
}

interface RenderItemOptions {
  summary: RecordingSummary;
  onSelect: (recordingId: string) => void;
  onDelete: (recordingId: string) => void | Promise<void>;
}

interface RenderedItem {
  element: HTMLElement;
  dispose: () => void;
}

function renderItem(options: RenderItemOptions): RenderedItem {
  const { summary, onSelect, onDelete } = options;

  const element = document.createElement("div");
  element.className = "recording-item";
  element.dataset.recordingId = summary.recordingId;

  const main = document.createElement("button");
  main.type = "button";
  main.className = "recording-item-main";
  main.addEventListener("click", () => {
    onSelect(summary.recordingId);
  });

  const date = document.createElement("span");
  date.className = "recording-date";
  date.textContent = formatDate(summary.createdAt);

  const count = document.createElement("span");
  count.className = "recording-attachment-count";
  const n = summary.attachmentCount;
  count.textContent = `${n} attachment${n === 1 ? "" : "s"}`;

  main.append(date, count);

  const actionWrap = document.createElement("div");
  actionWrap.className = "recording-item-actions";

  const selector = document.createElement("button");
  selector.type = "button";
  selector.className = "recording-item-selector";
  selector.setAttribute("aria-haspopup", "menu");
  selector.setAttribute("aria-expanded", "false");
  selector.setAttribute("aria-label", "Open recording menu");
  selector.textContent = "...";

  const menu = document.createElement("div");
  menu.className = "recording-item-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "recording-item-menu-item";
  deleteButton.textContent = "Delete";
  deleteButton.setAttribute("role", "menuitem");
  menu.append(deleteButton);

  let menuOpen = false;
  let deletePending = false;
  let removeDocClick: (() => void) | null = null;

  const closeMenu = (): void => {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    selector.setAttribute("aria-expanded", "false");
    removeDocClick?.();
    removeDocClick = null;
  };

  const openMenu = (): void => {
    if (menuOpen) return;
    menuOpen = true;
    menu.hidden = false;
    selector.setAttribute("aria-expanded", "true");

    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (element.contains(target)) return;
      closeMenu();
    };

    document.addEventListener("click", onDocumentClick);
    removeDocClick = () => {
      document.removeEventListener("click", onDocumentClick);
    };
  };

  selector.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menuOpen) {
      closeMenu();
      return;
    }
    openMenu();
  });

  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (deletePending) {
      return;
    }
    closeMenu();
    deletePending = true;
    deleteButton.disabled = true;

    void (async () => {
      const confirmed = await confirmDelete();
      if (!confirmed) {
        return;
      }
      await onDelete(summary.recordingId);
    })().finally(() => {
      deletePending = false;
      deleteButton.disabled = false;
    });
  });

  actionWrap.append(selector, menu);
  element.append(main, actionWrap);

  return {
    element,
    dispose: closeMenu,
  };
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

async function confirmDelete(): Promise<boolean> {
  const confirmFn = window.confirm as unknown as (message?: string) => unknown;
  const value = confirmFn("Delete this recording?");
  if (typeof value === "boolean") {
    return value;
  }
  if (isPromiseLike(value)) {
    try {
      return Boolean(await value);
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("then" in value)) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === "function";
}
