import { describe, it, expect } from "vitest";
import { SerialQueue, QueueJobState } from "./serial-queue";

describe("SerialQueue", () => {
  it("runs tasks in order", async () => {
    const q = new SerialQueue("test");
    const order: number[] = [];

    q.enqueue(() => order.push(1));
    q.enqueue(() => order.push(2));
    await q.enqueue(() => order.push(3));

    expect(order).toEqual([1, 2, 3]);
  });

  it("reports status transitions", async () => {
    const q = new SerialQueue("test");
    const statuses: QueueJobState["status"][] = [];

    await q.enqueue(() => "ok", {
      onStatus: (s) => statuses.push(s.status),
    });

    expect(statuses).toEqual(["queued", "running", "completed"]);
  });

  it("reports error status on failure", async () => {
    const q = new SerialQueue("test");
    const statuses: QueueJobState["status"][] = [];

    await q
      .enqueue(
        () => {
          throw new Error("boom");
        },
        { onStatus: (s) => statuses.push(s.status) },
      )
      .catch(() => {});

    expect(statuses).toEqual(["queued", "running", "error"]);
  });

  it("continues after a failed task", async () => {
    const q = new SerialQueue("test");

    q.enqueue(() => {
      throw new Error("fail");
    }).catch(() => {});

    const result = await q.enqueue(() => 42);
    expect(result).toBe(42);
  });

  it("tracks depth correctly", async () => {
    const q = new SerialQueue("test");
    expect(q.depth).toBe(0);

    let resolve!: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    q.enqueue(() => blocker);
    q.enqueue(() => {});

    // One running, one pending
    expect(q.depth).toBe(2);

    resolve();
    await q.waitForIdle();
    expect(q.depth).toBe(0);
  });
});
