// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { NoopRecordingStore } from "../../storage/noop-store";
import type { RecordingService } from "../recording-service";
import {
  ListController,
  RECORDINGS_CHANGED_EVENT,
  fireRecordingsChanged,
} from "./index";

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
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
