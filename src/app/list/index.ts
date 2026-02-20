import type { RecordingSummary } from "../../domain/recording";
import type { RecordingStore } from "../../storage/store";
import { normalizeSearchText } from "../search-text";

export const RECORDINGS_CHANGED_EVENT = "toru:recordings-changed";

export interface ListControllerOptions {
  container: HTMLElement;
  store: RecordingStore;
  searchInput?: HTMLInputElement;
  onSelect?: (recordingId: string) => void;
}

export class ListController {
  private readonly container: HTMLElement;
  private readonly store: RecordingStore;
  private readonly searchInput: HTMLInputElement | null;
  private readonly onSelect: (recordingId: string) => void;
  private readonly canExportRecordings: boolean;
  private summaries: RecordingSummary[] = [];
  private query = "";
  private searchDebounce: number | null = null;
  private listening = false;
  private refreshSeq = 0;
  private itemDisposers: Array<() => void> = [];
  private readonly onChanged = (): void => {
    void this.refresh();
  };
  private readonly onSearchInput = (): void => {
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce);
    }
    this.searchDebounce = window.setTimeout(() => {
      this.searchDebounce = null;
      this.query = normalizeSearchText(this.searchInput?.value ?? "");
      this.render();
    }, 300);
  };

  constructor(options: ListControllerOptions) {
    this.container = options.container;
    this.store = options.store;
    this.searchInput = options.searchInput ?? null;
    this.onSelect = options.onSelect ?? (() => undefined);
    this.canExportRecordings = this.store.canExportRecordings();
  }

  mount(): void {
    if (!this.listening) {
      document.addEventListener(RECORDINGS_CHANGED_EVENT, this.onChanged);
      this.searchInput?.addEventListener("input", this.onSearchInput);
      this.listening = true;
    }
    this.query = normalizeSearchText(this.searchInput?.value ?? "");
    void this.refresh();
  }

  unmount(): void {
    if (this.listening) {
      document.removeEventListener(RECORDINGS_CHANGED_EVENT, this.onChanged);
      this.searchInput?.removeEventListener("input", this.onSearchInput);
      this.listening = false;
    }
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
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
      this.summaries = [];
      this.teardownItems();
      this.container.textContent = `Failed to load recordings: ${message}`;
      return;
    }

    if (seq !== this.refreshSeq) return;
    this.summaries = summaries.map((summary) => ({
      ...summary,
      searchText: normalizeSearchText(summary.searchText),
    }));
    this.render();
  }

  private teardownItems(): void {
    for (const dispose of this.itemDisposers) {
      dispose();
    }
    this.itemDisposers = [];
  }

  private render(): void {
    if (this.summaries.length === 0) {
      this.teardownItems();
      this.container.replaceChildren(renderEmptyState());
      return;
    }

    const filtered = filterSummaries(this.summaries, this.query);
    if (filtered.length === 0) {
      this.teardownItems();
      this.container.replaceChildren(
        renderEmptyState({
          title: "No matching sessions",
          subtitle: "Try another search phrase",
        }),
      );
      return;
    }

    const rendered = filtered.map(({ summary, matchCount }) =>
      renderItem({
        summary,
        matchCount,
        canExport: this.canExportRecordings,
        onSelect: this.onSelect,
        onExport: (recordingId, createdAt) =>
          this.exportRecording(recordingId, createdAt),
        onDelete: (recordingId) => this.deleteRecording(recordingId),
      }),
    );

    this.teardownItems();
    this.itemDisposers = rendered.map((item) => item.dispose);
    this.container.replaceChildren(...rendered.map((item) => item.element));
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

  private async exportRecording(
    recordingId: string,
    createdAt: string,
  ): Promise<void> {
    let destinationPath: string | null;
    try {
      destinationPath = await pickExportPath(createdAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to open export dialog: ${message}`);
      return;
    }

    if (!destinationPath) {
      return;
    }

    try {
      await this.store.exportRecording(recordingId, destinationPath);
      await notifyExportSuccess(destinationPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`Failed to export recording: ${message}`);
    }
  }
}

interface RenderItemOptions {
  summary: RecordingSummary;
  matchCount: number;
  canExport: boolean;
  onSelect: (recordingId: string) => void;
  onExport: (recordingId: string, createdAt: string) => void | Promise<void>;
  onDelete: (recordingId: string) => void | Promise<void>;
}

interface RenderedItem {
  element: HTMLElement;
  dispose: () => void;
}

function renderItem(options: RenderItemOptions): RenderedItem {
  const { summary, matchCount, canExport, onSelect, onExport, onDelete } =
    options;

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

  const meta = document.createElement("span");
  meta.className = "recording-item-meta";

  if (matchCount > 0) {
    const matches = document.createElement("span");
    matches.className = "recording-match-count";
    matches.textContent = `${matchCount} match${matchCount === 1 ? "" : "es"}`;
    meta.append(matches);
  }
  meta.append(count);
  main.append(date, meta);

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

  let exportButton: HTMLButtonElement | null = null;
  if (canExport) {
    exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "recording-item-menu-item";
    exportButton.textContent = "Export";
    exportButton.setAttribute("role", "menuitem");
    menu.append(exportButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className =
    "recording-item-menu-item recording-item-menu-item-destructive";
  deleteButton.textContent = "Delete";
  deleteButton.setAttribute("role", "menuitem");
  menu.append(deleteButton);

  let menuOpen = false;
  let exportPending = false;
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

  if (exportButton) {
    const button = exportButton;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (exportPending) {
        return;
      }
      closeMenu();
      exportPending = true;
      button.disabled = true;

      void Promise.resolve(
        onExport(summary.recordingId, summary.createdAt),
      ).finally(() => {
        exportPending = false;
        button.disabled = false;
      });
    });
  }

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

async function pickExportPath(createdAt: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: "Export Recording Session",
    defaultPath: `${formatDateFilename(createdAt)}.zip`,
    filters: [{ name: "Zip Archive", extensions: ["zip"] }],
  });
  if (typeof selected !== "string") {
    return null;
  }
  const trimmed = selected.trim();
  if (!trimmed) {
    return null;
  }
  return ensureZipExtension(trimmed);
}

function ensureZipExtension(path: string): string {
  if (path.toLowerCase().endsWith(".zip")) {
    return path;
  }
  return `${path}.zip`;
}

function formatDateFilename(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "recording";
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${hh}-${mm}`;
}

async function notifyExportSuccess(destinationPath: string): Promise<void> {
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(`Exported to ${destinationPath}`, {
      title: "Success!",
      kind: "info",
    });
  } catch {
    // Best effort success notification; export already completed.
  }
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

function filterSummaries(
  summaries: RecordingSummary[],
  query: string,
): Array<{ summary: RecordingSummary; matchCount: number }> {
  if (!query) {
    return summaries.map((summary) => ({ summary, matchCount: 0 }));
  }

  const matches: Array<{ summary: RecordingSummary; matchCount: number }> = [];
  for (const summary of summaries) {
    const matchCount = countMatches(summary.searchText, query);
    if (matchCount > 0) {
      matches.push({ summary, matchCount });
    }
  }
  return matches;
}

function countMatches(value: string, query: string): number {
  if (!query) {
    return 0;
  }

  let total = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const index = value.indexOf(query, cursor);
    if (index === -1) {
      break;
    }
    total += 1;
    cursor = index + query.length;
  }
  return total;
}

function renderEmptyState(options?: {
  title?: string;
  subtitle?: string;
}): HTMLElement {
  const title = options?.title ?? "No sessions yet";
  const subtitle = options?.subtitle ?? "Open a new session to get started";
  const el = document.createElement("div");
  el.className = "empty-state";
  const titleEl = document.createElement("p");
  titleEl.textContent = title;
  const subtitleEl = document.createElement("p");
  subtitleEl.textContent = subtitle;
  el.append(createEmptyStateIcon(), titleEl, subtitleEl);
  return el;
}

function createEmptyStateIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("class", "empty-state-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");

  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "4");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("rx", "2");
  rect.setAttribute("ry", "2");

  const line1 = document.createElementNS(ns, "line");
  line1.setAttribute("x1", "16");
  line1.setAttribute("y1", "2");
  line1.setAttribute("x2", "16");
  line1.setAttribute("y2", "6");

  const line2 = document.createElementNS(ns, "line");
  line2.setAttribute("x1", "8");
  line2.setAttribute("y1", "2");
  line2.setAttribute("x2", "8");
  line2.setAttribute("y2", "6");

  const line3 = document.createElementNS(ns, "line");
  line3.setAttribute("x1", "3");
  line3.setAttribute("y1", "10");
  line3.setAttribute("x2", "21");
  line3.setAttribute("y2", "10");

  icon.append(rect, line1, line2, line3);
  return icon;
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
