import { describe, expect, it, vi } from "vitest";
import { StreamingRequestQueue } from "../src/services/streaming-request-queue.js";

describe("streaming request queue", () => {
  it("rejects intervals outside the 1–2 second safety window", async () => {
    const queue = new StreamingRequestQueue();
    await expect(queue.enqueue("animego", async () => true, { minIntervalMs: 500 }))
      .rejects.toThrow("between 1000 and 2000");
  });

  it("serializes operations for a provider", async () => {
    const queue = new StreamingRequestQueue();
    const order: string[] = [];
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { finishFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const first = queue.enqueue("anixart", async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-end");
    }, { minIntervalMs: 1000 });
    const second = queue.enqueue("anixart", async () => { order.push("second-start"); }, { minIntervalMs: 1000 });

    await firstStarted;
    expect(order).toEqual(["first-start"]);
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not execute a queued task after its signal is aborted", async () => {
    vi.useFakeTimers();
    const queue = new StreamingRequestQueue();
    const first = queue.enqueue("yummyanime", async () => true, { minIntervalMs: 1000 });
    await first;
    const controller = new AbortController();
    const task = vi.fn(async () => true);
    const pending = queue.enqueue("yummyanime", task, { minIntervalMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(task).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
