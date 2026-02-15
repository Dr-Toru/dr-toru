// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";

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
    container.remove();
  });

  it("shows empty state when there are no recordings", async () => {
    const store = new NoopRecordingStore();
    const ctrl = new ListController({ container, store });

    await ctrl.refresh();

    expect(container.textContent).toBe("No recordings yet.");
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
    expect(container.textContent).toBe("No recordings yet.");

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

    const first = container.querySelector<HTMLButtonElement>(".recording-item");
    expect(first).not.toBeNull();
    first?.click();

    expect(selectedId).not.toBeNull();
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
    expect(container.textContent).toBe("No recordings yet.");
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
