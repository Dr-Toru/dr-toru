// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { NoopRecordingStore } from "../../storage/noop-store";
import type { RecordingService } from "../recording-service";
import {
  ListController,
  RECORDINGS_CHANGED_EVENT,
  fireRecordingsChanged,
} from "./index";

const { saveDialogMock, messageDialogMock } = vi.hoisted(() => ({
  saveDialogMock: vi.fn(),
  messageDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveDialogMock,
  message: messageDialogMock,
}));

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeSearchInput(): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "search";
  document.body.appendChild(el);
  return el;
}

describe("ListController", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = makeContainer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    saveDialogMock.mockReset();
    messageDialogMock.mockReset();
    container.remove();
  });

  it("shows empty state when there are no recordings", async () => {
    const store = new NoopRecordingStore();
    const ctrl = new ListController({ container, store });

    await ctrl.refresh();

    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("renders recording items after persist", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);

    await saveInNewRecording(service, "First note");
    await saveInNewRecording(service, "Second note");

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const items = container.querySelectorAll(".recording-item");
    expect(items).toHaveLength(2);

    // Sorted newest first — second note should be first in the list
    const dates = container.querySelectorAll(".recording-date");
    expect(dates).toHaveLength(2);
    for (const dateEl of dates) {
      expect(dateEl.textContent).not.toBe("");
    }

    const counts = container.querySelectorAll(".recording-attachment-count");
    for (const countEl of counts) {
      expect(countEl.textContent).toBe("1 attachment");
    }
  });

  it("filters sessions by transcript text", async () => {
    vi.useFakeTimers();
    try {
      const store = new NoopRecordingStore();
      const { RecordingService } = await import("../recording-service");
      const service = new RecordingService(store);

      await saveInNewRecording(service, "Acute shortness of breath");
      await saveInNewRecording(
        service,
        "Patient denies chest pain but reports chest tightness",
      );

      const searchInput = makeSearchInput();
      const ctrl = new ListController({ container, store, searchInput });
      ctrl.mount();
      await ctrl.refresh();

      expect(container.querySelectorAll(".recording-item")).toHaveLength(2);
      expect(container.querySelector(".recording-match-count")).toBeNull();

      searchInput.value = "CHEST";
      searchInput.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      expect(container.querySelectorAll(".recording-item")).toHaveLength(1);
      expect(
        container.querySelector(".recording-match-count")?.textContent,
      ).toBe("2 matches");

      searchInput.value = "xylophone";
      searchInput.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      expect(container.querySelectorAll(".recording-item")).toHaveLength(0);
      expect(container.textContent).toContain("No matching sessions");

      ctrl.unmount();
      searchInput.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes on recordings-changed event when mounted", async () => {
    const store = new NoopRecordingStore();
    const ctrl = new ListController({ container, store });
    ctrl.mount();

    // Initially empty
    await flushMicrotasks();
    expect(container.querySelector(".empty-state")).not.toBeNull();

    // Add a recording and fire event
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    fireRecordingsChanged();
    await flushMicrotasks();

    expect(container.querySelectorAll(".recording-item")).toHaveLength(1);

    ctrl.unmount();
  });

  it("calls onSelect when a recording item is clicked", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    let selectedId: string | null = null;
    const ctrl = new ListController({
      container,
      store,
      onSelect: (recordingId) => {
        selectedId = recordingId;
      },
    });
    await ctrl.refresh();

    const first = container.querySelector<HTMLButtonElement>(
      ".recording-item-main",
    );
    expect(first).not.toBeNull();
    first?.click();

    expect(selectedId).not.toBeNull();
  });

  it("opens the selector menu and closes on outside click", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    const menu = container.querySelector<HTMLElement>(".recording-item-menu");
    expect(selector).not.toBeNull();
    expect(menu).not.toBeNull();
    expect(menu?.hidden).toBe(true);

    selector?.click();
    expect(menu?.hidden).toBe(false);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu?.hidden).toBe(true);
  });

  it("asks for delete confirmation and removes recording on confirm", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".recording-item-menu-item",
    );
    deleteButton?.click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(confirmSpy).toHaveBeenCalledWith("Delete this recording?");
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("shows export action when store supports export", async () => {
    const store = new NoopRecordingStore();
    store.canExportRecordings = () => true;

    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".recording-item-menu-item",
      ),
    ).map((button) => button.textContent);
    expect(labels).toEqual(["Export", "Delete"]);
  });

  it("exports recording with save dialog path", async () => {
    const store = new NoopRecordingStore();
    store.canExportRecordings = () => true;

    const exportSpy = vi.fn(async () => undefined);
    store.exportRecording = exportSpy;
    saveDialogMock.mockResolvedValue("/tmp/session-export");

    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const recordingId =
      container.querySelector<HTMLElement>(".recording-item")?.dataset
        .recordingId;
    expect(recordingId).toBeTruthy();
    const recording = (await store.listRecordings())[0];
    expect(recording).toBeTruthy();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const exportButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".recording-item-menu-item",
      ),
    ).find((button) => button.textContent === "Export");
    exportButton?.click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(saveDialogMock).toHaveBeenCalledWith({
      title: "Export Recording Session",
      defaultPath: `${toDateFilename(recording!.createdAt)}.zip`,
      filters: [{ name: "Zip Archive", extensions: ["zip"] }],
    });
    expect(exportSpy).toHaveBeenCalledWith(
      recordingId,
      "/tmp/session-export.zip",
    );
  });

  it("shows success notification after export", async () => {
    const store = new NoopRecordingStore();
    store.canExportRecordings = () => true;

    const exportSpy = vi.fn(async () => undefined);
    store.exportRecording = exportSpy;
    saveDialogMock.mockResolvedValue("/tmp/session-export");

    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const recordingId =
      container.querySelector<HTMLElement>(".recording-item")?.dataset
        .recordingId;
    expect(recordingId).toBeTruthy();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const exportButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".recording-item-menu-item",
      ),
    ).find((button) => button.textContent === "Export");
    exportButton?.click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(exportSpy).toHaveBeenCalled();
    expect(messageDialogMock).toHaveBeenCalledWith(
      "Exported to /tmp/session-export.zip",
      {
        title: "Success!",
        kind: "info",
      },
    );
  });

  it("keeps recording when delete confirmation is canceled", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".recording-item-menu-item",
    );
    deleteButton?.click();
    await flushMicrotasks();

    expect(confirmSpy).toHaveBeenCalledWith("Delete this recording?");
    expect(container.querySelectorAll(".recording-item")).toHaveLength(1);
  });

  it("waits for async confirmation before deleting", async () => {
    const store = new NoopRecordingStore();
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    const gate = deferred<boolean>();
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(
        (() => gate.promise) as unknown as typeof window.confirm,
      );

    const ctrl = new ListController({ container, store });
    await ctrl.refresh();

    const selector = container.querySelector<HTMLButtonElement>(
      ".recording-item-selector",
    );
    selector?.click();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      ".recording-item-menu-item",
    );
    deleteButton?.click();
    await flushMicrotasks();

    expect(confirmSpy).toHaveBeenCalledWith("Delete this recording?");
    expect(container.querySelectorAll(".recording-item")).toHaveLength(1);

    gate.resolve(true);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("stops listening after unmount", async () => {
    const store = new NoopRecordingStore();
    const ctrl = new ListController({ container, store });
    ctrl.mount();
    await flushMicrotasks();

    ctrl.unmount();

    // Add a recording and fire — should NOT update
    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);
    await saveInNewRecording(service, "A note");

    fireRecordingsChanged();
    await flushMicrotasks();

    // Still shows old empty state
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  it("discards stale refresh results when a newer refresh starts", async () => {
    let callCount = 0;
    const gate = deferred<void>();
    const store = new NoopRecordingStore();

    // Patch listRecordings so the first call blocks until we release it,
    // while the second call resolves immediately.
    const original = store.listRecordings.bind(store);
    store.listRecordings = async () => {
      callCount++;
      if (callCount === 1) {
        await gate.promise;
      }
      return original();
    };

    const { RecordingService } = await import("../recording-service");
    const service = new RecordingService(store);

    const ctrl = new ListController({ container, store });

    // First refresh — will block on gate
    const first = ctrl.refresh();

    // Add a recording, then trigger a second refresh before the first resolves
    await saveInNewRecording(service, "New note");
    const second = ctrl.refresh();

    // Release the first call — its result is now stale
    gate.resolve();
    await first;
    await second;

    // The DOM should reflect the second (newer) result, not the first (empty)
    expect(container.querySelectorAll(".recording-item")).toHaveLength(1);
  });

  it("fires event via fireRecordingsChanged helper", () => {
    let fired = false;
    document.addEventListener(
      RECORDINGS_CHANGED_EVENT,
      () => {
        fired = true;
      },
      { once: true },
    );
    fireRecordingsChanged();
    expect(fired).toBe(true);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function toDateFilename(iso: string): string {
  const date = new Date(iso);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${hh}-${mm}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function saveInNewRecording(
  service: Pick<RecordingService, "createDraftRecordingId" | "saveTranscript">,
  transcript: string,
): Promise<void> {
  const recordingId = service.createDraftRecordingId();
  await service.saveTranscript({ recordingId, transcript });
}
