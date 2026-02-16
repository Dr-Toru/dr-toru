// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { RecordingService } from "./recording-service";
import {
  RecordingViewController,
  formatElapsed,
} from "./recording-view-controller";

describe("RecordingViewController", () => {
  it("creates a fresh draft each time plain recording route is opened", async () => {
    const service = makeServiceStub();
    const { controller } = makeController(service);

    const first = await controller.openRoute(null);
    const second = await controller.openRoute(null);

    expect(first.status).toBe("opened");
    expect(second.status).toBe("opened");
    if (first.status !== "opened" || second.status !== "opened") {
      return;
    }
    expect(first.recordingId).not.toBe(second.recordingId);
  });

  it("blocks route context changes while recording", async () => {
    const service = makeServiceStub();
    const { controller } = makeController(service);
    const opened = await controller.openRoute(null);
    expect(opened.status).toBe("opened");

    controller.setRecording(true);
    const blockedForId = await controller.openRoute("existing-id");
    const blockedForDraft = await controller.openRoute(null);

    expect(blockedForId).toEqual({ status: "blocked" });
    expect(blockedForDraft).toEqual({ status: "blocked" });
  });

  it("starts timer on recording and stops on stop", () => {
    vi.useFakeTimers();
    try {
      const service = makeServiceStub();
      const { controller, timerEl } = makeController(service);

      controller.setRecording(true);
      expect(timerEl.textContent).toBe("0:00");
      expect(timerEl.classList.contains("recording")).toBe(true);

      vi.advanceTimersByTime(5000);
      expect(timerEl.textContent).toBe("0:05");

      controller.setRecording(false);
      expect(timerEl.classList.contains("recording")).toBe(false);
      expect(timerEl.textContent).toBe("0:05");

      vi.advanceTimersByTime(3000);
      expect(timerEl.textContent).toBe("0:05");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets timer when opening a new recording route", async () => {
    vi.useFakeTimers();
    try {
      const service = makeServiceStub();
      const { controller, timerEl } = makeController(service);

      controller.setRecording(true);
      vi.advanceTimersByTime(10000);
      expect(timerEl.textContent).toBe("0:10");

      controller.setRecording(false);
      expect(timerEl.textContent).toBe("0:10");

      await controller.openRoute(null);
      expect(timerEl.textContent).toBe("0:00");
      expect(timerEl.classList.contains("recording")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows save failures and preserves unsaved transcript text", async () => {
    const service = makeServiceStub({
      saveTranscript: async () => {
        throw new Error("disk error");
      },
    });
    const onError = vi.fn();
    const { controller, transcriptEl } = makeController(service, onError);

    const opened = await controller.openRoute(null);
    expect(opened.status).toBe("opened");

    await expect(
      controller.onRecordingComplete("unsaved text"),
    ).rejects.toThrow("disk error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(transcriptEl.value).toBe("unsaved text");
  });
});

describe("formatElapsed", () => {
  it("formats zero", () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  it("formats seconds under a minute", () => {
    expect(formatElapsed(59_999)).toBe("0:59");
  });

  it("formats exactly one minute", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
  });

  it("formats multi-digit minutes", () => {
    expect(formatElapsed(599_000)).toBe("9:59");
    expect(formatElapsed(600_000)).toBe("10:00");
    expect(formatElapsed(750_000)).toBe("12:30");
  });

  it("formats over an hour as continued minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("60:00");
    expect(formatElapsed(4_335_000)).toBe("72:15");
  });
});

function makeController(
  service: RecordingService,
  onError: (error: unknown, context: string) => void = () => undefined,
): {
  controller: RecordingViewController;
  transcriptEl: HTMLTextAreaElement;
  timerEl: HTMLElement;
} {
  const transcriptEl = document.createElement("textarea");
  const transcribeBtn = document.createElement("button");
  const timerEl = document.createElement("span");
  timerEl.textContent = "0:00";
  const controller = new RecordingViewController({
    transcriptEl,
    transcribeBtn,
    timerEl,
    recordingService: service,
    onToggleRecording: async () => undefined,
    onRecordingsChanged: () => undefined,
    onError,
  });
  return { controller, transcriptEl, timerEl };
}

function makeServiceStub(
  overrides: Partial<RecordingService> = {},
): RecordingService {
  let seq = 0;
  const base = {
    createDraftRecordingId: () => `draft-${++seq}`,
    loadTranscript: async () => null,
    saveTranscript: async (input: {
      recordingId: string;
      transcript: string;
    }) =>
      ({
        recordingId: input.recordingId,
        attachmentId: "att-1",
        transcript: input.transcript,
      }) as never,
  };
  return { ...base, ...overrides } as unknown as RecordingService;
}
