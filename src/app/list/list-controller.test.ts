// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { NoopRecordingStore } from "../../storage/noop-store";
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

    await service.persistTranscript("First note");
    await service.persistTranscript("Second note");

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
    await service.persistTranscript("A note");

    fireRecordingsChanged();
    await flushMicrotasks();

    expect(container.querySelectorAll(".recording-item")).toHaveLength(1);

    ctrl.unmount();
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
    await service.persistTranscript("A note");

    fireRecordingsChanged();
    await flushMicrotasks();

    // Still shows old empty state
    expect(container.textContent).toBe("No recordings yet.");
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
