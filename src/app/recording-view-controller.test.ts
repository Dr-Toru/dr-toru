// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { RecordingService } from "./recording-service";
import { RecordingViewController } from "./recording-view-controller";

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

function makeController(
  service: RecordingService,
  onError: (error: unknown, context: string) => void = () => undefined,
): { controller: RecordingViewController; transcriptEl: HTMLTextAreaElement } {
  const transcriptEl = document.createElement("textarea");
  const transcribeBtn = document.createElement("button");
  const controller = new RecordingViewController({
    transcriptEl,
    transcribeBtn,
    recordingService: service,
    onToggleRecording: async () => undefined,
    onRecordingsChanged: () => undefined,
    onError,
  });
  return { controller, transcriptEl };
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
