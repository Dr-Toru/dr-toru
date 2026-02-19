// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import { computeRms } from "../audio/capture";
import type { RecordingService } from "./recording-service";
import {
  RecordingViewController,
  formatElapsed,
  levelToHeight,
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
    const chunkText = transcriptEl.querySelector(".chunk-text");
    expect(chunkText!.textContent).toBe("unsaved text");
  });

  it("disables both actions while upload transcription is running", async () => {
    const service = makeServiceStub();
    const { controller, transcribeBtn, uploadBtn } = makeController(service);
    await controller.openRoute(null);
    controller.setTranscribeAvailable(true);

    controller.setUploading(true);
    expect(transcribeBtn.disabled).toBe(true);
    expect(uploadBtn.disabled).toBe(true);

    controller.setUploading(false);
    expect(transcribeBtn.disabled).toBe(false);
    expect(uploadBtn.disabled).toBe(false);
  });

  it("disables actions while model loading is active", async () => {
    const service = makeServiceStub();
    const { controller, transcribeBtn, uploadBtn } = makeController(service);
    await controller.openRoute(null);
    controller.setTranscribeAvailable(true);

    controller.setModelLoading(true);
    expect(transcribeBtn.disabled).toBe(true);
    expect(uploadBtn.disabled).toBe(true);

    controller.setModelLoading(false);
    expect(transcribeBtn.disabled).toBe(false);
    expect(uploadBtn.disabled).toBe(false);
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

describe("computeRms", () => {
  it("returns 0 for empty input", () => {
    expect(computeRms(new Float32Array([]))).toBe(0);
  });

  it("returns 0 for silence", () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it("returns correct RMS for known signal", () => {
    const samples = new Float32Array([1, -1, 1, -1]);
    expect(computeRms(samples)).toBeCloseTo(1, 5);
  });

  it("returns correct RMS for a 0.5 signal", () => {
    const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(computeRms(samples)).toBeCloseTo(0.5, 5);
  });
});

describe("levelToHeight", () => {
  it("returns MIN_BAR_HEIGHT for 0", () => {
    expect(levelToHeight(0)).toBe(4);
  });

  it("returns MIN_BAR_HEIGHT for negative values", () => {
    expect(levelToHeight(-0.1)).toBe(4);
  });

  it("returns MAX_BAR_HEIGHT for LOUD_SPEECH_RMS (0.15)", () => {
    expect(levelToHeight(0.15)).toBe(20);
  });

  it("clamps at MAX_BAR_HEIGHT for values above LOUD_SPEECH_RMS", () => {
    expect(levelToHeight(1.0)).toBe(20);
  });

  it("produces intermediate values for moderate speech", () => {
    const height = levelToHeight(0.03);
    expect(height).toBeGreaterThan(4);
    expect(height).toBeLessThan(20);
  });

  it("uses sqrt curve (quiet speech still visible)", () => {
    const quiet = levelToHeight(0.005);
    const mid = levelToHeight(0.075);
    expect(quiet).toBeGreaterThan(4);
    expect(mid).toBeGreaterThan(quiet);
    expect(mid).toBeLessThan(20);
  });
});

describe("setLevel and bar management", () => {
  it("sets different heights on each bar using BAR_SCALE", () => {
    const service = makeServiceStub();
    const { controller, barEls } = makeController(service);

    controller.setRecording(true);
    controller.setLevel(0.05);

    const heights = barEls.map((b) => parseFloat(b.style.height));
    expect(heights.length).toBe(4);
    // bars should not all be the same
    expect(new Set(heights).size).toBeGreaterThan(1);
    // all should be >= MIN_BAR_HEIGHT
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(4);
    }
  });

  it("returns MIN_BAR_HEIGHT for all bars when rms is 0", () => {
    const service = makeServiceStub();
    const { controller, barEls } = makeController(service);

    controller.setRecording(true);
    controller.setLevel(0);

    for (const bar of barEls) {
      expect(parseFloat(bar.style.height)).toBe(4);
    }
  });

  it("is a no-op when not recording", () => {
    const service = makeServiceStub();
    const { controller, barEls } = makeController(service);

    controller.setLevel(0.1);

    for (const bar of barEls) {
      expect(bar.style.height).toBe("4px");
    }
  });

  it("resets bars to MIN_BAR_HEIGHT when recording stops", () => {
    const service = makeServiceStub();
    const { controller, barEls } = makeController(service);

    controller.setRecording(true);
    controller.setLevel(0.1);

    // Verify bars were set above minimum
    const heightsBefore = barEls.map((b) => parseFloat(b.style.height));
    expect(Math.max(...heightsBefore)).toBeGreaterThan(4);

    controller.setRecording(false);

    for (const bar of barEls) {
      expect(parseFloat(bar.style.height)).toBe(4);
    }
  });
});

describe("typing indicator", () => {
  it("shows indicator when recording starts", () => {
    const service = makeServiceStub();
    const { controller, typingIndicatorEl } = makeController(service);

    controller.setRecording(true);
    expect(typingIndicatorEl.hidden).toBe(false);
  });

  it("keeps indicator visible while recording even after transcript arrives", () => {
    const service = makeServiceStub();
    const { controller, typingIndicatorEl } = makeController(service);

    controller.setRecording(true);
    expect(typingIndicatorEl.hidden).toBe(false);

    controller.setLiveTranscript("hello");
    expect(typingIndicatorEl.hidden).toBe(false);
  });

  it("hides indicator when recording stops", () => {
    const service = makeServiceStub();
    const { controller, typingIndicatorEl } = makeController(service);

    controller.setRecording(true);
    expect(typingIndicatorEl.hidden).toBe(false);

    controller.setRecording(false);
    expect(typingIndicatorEl.hidden).toBe(true);
  });

  it("does not hide indicator on empty transcript", () => {
    const service = makeServiceStub();
    const { controller, typingIndicatorEl } = makeController(service);

    controller.setRecording(true);
    controller.setLiveTranscript("");
    expect(typingIndicatorEl.hidden).toBe(false);
  });

  it("reappears on second recording", () => {
    const service = makeServiceStub();
    const { controller, typingIndicatorEl } = makeController(service);

    controller.setRecording(true);
    controller.setLiveTranscript("text");
    expect(typingIndicatorEl.hidden).toBe(false);

    controller.setRecording(false);
    expect(typingIndicatorEl.hidden).toBe(true);

    controller.setRecording(true);
    expect(typingIndicatorEl.hidden).toBe(false);
  });

  it("renders live transcript text in a chunk element", () => {
    const service = makeServiceStub();
    const { controller, transcriptEl } = makeController(service);

    controller.setRecording(true);
    controller.setLiveTranscript("hello world");

    const chunks = transcriptEl.querySelectorAll(".transcript-chunk");
    expect(chunks.length).toBe(1);
    const text = chunks[0]!.querySelector(".chunk-text");
    expect(text!.textContent).toBe("hello world");
  });
});

describe("context textarea", () => {
  it("clears context textarea on openRoute(null)", async () => {
    const service = makeServiceStub();
    const { controller, contextNoteEl } = makeController(service);

    contextNoteEl.value = "leftover text";
    await controller.openRoute(null);
    expect(contextNoteEl.value).toBe("");
  });

  it("loads context text when opening an existing recording", async () => {
    const service = makeServiceStub({
      loadTranscript: async () => ({
        recordingId: "rec-1",
        attachmentId: "att-1",
        transcript: "some transcript",
      }),
      loadContext: async () => ({
        recordingId: "rec-1",
        attachmentId: "ctx-1",
        context: "patient context notes",
      }),
    });
    const { controller, contextNoteEl } = makeController(service);

    const result = await controller.openRoute("rec-1");
    expect(result.status).toBe("opened");
    expect(contextNoteEl.value).toBe("patient context notes");
  });

  it("sets empty context when existing recording has no context", async () => {
    const service = makeServiceStub({
      loadTranscript: async () => ({
        recordingId: "rec-1",
        attachmentId: "att-1",
        transcript: "some transcript",
      }),
      loadContext: async () => null,
    });
    const { controller, contextNoteEl } = makeController(service);

    await controller.openRoute("rec-1");
    expect(contextNoteEl.value).toBe("");
  });

  it("debounced save fires after input event", async () => {
    vi.useFakeTimers();
    try {
      const saveContext = vi.fn(
        async (input: { recordingId: string; context: string }) => ({
          recordingId: input.recordingId,
          attachmentId: "ctx-1",
          context: input.context,
        }),
      );
      const service = makeServiceStub({ saveContext: saveContext as never });
      const { controller, contextNoteEl } = makeController(service);

      await controller.openRoute(null);
      contextNoteEl.value = "patient info";
      contextNoteEl.dispatchEvent(new Event("input"));

      expect(saveContext).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveContext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("multiple inputs within debounce window only save once", async () => {
    vi.useFakeTimers();
    try {
      const saveContext = vi.fn(
        async (input: { recordingId: string; context: string }) => ({
          recordingId: input.recordingId,
          attachmentId: "ctx-1",
          context: input.context,
        }),
      );
      const service = makeServiceStub({ saveContext: saveContext as never });
      const { controller, contextNoteEl } = makeController(service);

      await controller.openRoute(null);
      contextNoteEl.value = "first";
      contextNoteEl.dispatchEvent(new Event("input"));

      await vi.advanceTimersByTimeAsync(500);
      contextNoteEl.value = "second";
      contextNoteEl.dispatchEvent(new Event("input"));

      await vi.advanceTimersByTimeAsync(1000);
      expect(saveContext).toHaveBeenCalledTimes(1);
      expect(saveContext).toHaveBeenCalledWith(
        expect.objectContaining({ context: "second" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending save on openRoute", async () => {
    vi.useFakeTimers();
    try {
      const saveContext = vi.fn(
        async (input: { recordingId: string; context: string }) => ({
          recordingId: input.recordingId,
          attachmentId: "ctx-1",
          context: input.context,
        }),
      );
      const service = makeServiceStub({ saveContext: saveContext as never });
      const { controller, contextNoteEl } = makeController(service);

      await controller.openRoute(null);
      contextNoteEl.value = "pending notes";
      contextNoteEl.dispatchEvent(new Event("input"));

      // Navigate away before debounce fires — should flush
      await controller.openRoute(null);
      expect(saveContext).toHaveBeenCalledTimes(1);
      expect(saveContext).toHaveBeenCalledWith(
        expect.objectContaining({ context: "pending notes" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function makeBars(count = 4): HTMLElement[] {
  return Array.from({ length: count }, () => {
    const el = document.createElement("span");
    el.style.height = "4px";
    return el;
  });
}

function makeController(
  service: RecordingService,
  onError: (error: unknown, context: string) => void = () => undefined,
  barEls: HTMLElement[] = makeBars(),
): {
  controller: RecordingViewController;
  transcriptEl: HTMLElement;
  contextNoteEl: HTMLTextAreaElement;
  transcribeBtn: HTMLButtonElement;
  uploadBtn: HTMLButtonElement;
  timerEl: HTMLElement;
  barEls: HTMLElement[];
  typingIndicatorEl: HTMLElement;
  onRecordingsChanged: ReturnType<typeof vi.fn>;
} {
  const transcriptEl = document.createElement("div");
  const contextNoteEl = document.createElement("textarea");
  const transcribeBtn = document.createElement("button");
  const uploadBtn = document.createElement("button");
  const timerEl = document.createElement("span");
  timerEl.textContent = "0:00";
  const typingIndicatorEl = document.createElement("div");
  typingIndicatorEl.hidden = true;
  const onRecordingsChanged = vi.fn();
  const controller = new RecordingViewController({
    transcriptEl,
    contextNoteEl,
    transcribeBtn,
    uploadBtn,
    timerEl,
    barEls,
    typingIndicatorEl,
    recordingService: service,
    onToggleRecording: async () => undefined,
    onUploadRequested: () => undefined,
    onRecordingsChanged,
    onError,
  });
  return {
    controller,
    transcriptEl,
    contextNoteEl,
    transcribeBtn,
    uploadBtn,
    timerEl,
    barEls,
    typingIndicatorEl,
    onRecordingsChanged,
  };
}

function makeServiceStub(
  overrides: Partial<RecordingService> = {},
): RecordingService {
  let seq = 0;
  const base = {
    createDraftRecordingId: () => `draft-${++seq}`,
    loadTranscript: async () => null,
    loadContext: async () => null,
    saveTranscript: async (input: {
      recordingId: string;
      transcript: string;
    }) =>
      ({
        recordingId: input.recordingId,
        attachmentId: "att-1",
        transcript: input.transcript,
      }) as never,
    saveContext: async (input: { recordingId: string; context: string }) =>
      ({
        recordingId: input.recordingId,
        attachmentId: "ctx-1",
        context: input.context,
      }) as never,
  };
  return { ...base, ...overrides } as unknown as RecordingService;
}
