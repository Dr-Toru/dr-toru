// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { RecordingService } from "./recording-service";
import { RecordingViewController } from "./recording-view-controller";

describe("RecordingViewController", () => {
  it("creates a fresh draft each time plain recording route is opened", async () => {
    const service = makeServiceStub();
    const controller = makeController(service);

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
    const controller = makeController(service);
    const opened = await controller.openRoute(null);
    expect(opened.status).toBe("opened");

    controller.setRecording(true);
    const blockedForId = await controller.openRoute("existing-id");
    const blockedForDraft = await controller.openRoute(null);

    expect(blockedForId).toEqual({ status: "blocked" });
    expect(blockedForDraft).toEqual({ status: "blocked" });
  });
});

function makeController(service: RecordingService): RecordingViewController {
  const transcriptEl = document.createElement("textarea");
  const transcribeBtn = document.createElement("button");
  return new RecordingViewController({
    transcriptEl,
    transcribeBtn,
    recordingService: service,
    onToggleRecording: async () => undefined,
    onRecordingsChanged: () => undefined,
    onError: () => undefined,
  });
}

function makeServiceStub(): RecordingService {
  let seq = 0;
  return {
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
  } as unknown as RecordingService;
}
