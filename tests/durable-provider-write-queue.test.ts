import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { DurableProviderWriteQueue } from "../src/services/durable-provider-write-queue.js";

const sample = {
  provider: "animego" as const,
  kind: "progress" as const,
  externalId: "12345",
  titleUrl: "https://animego.me/anime/example-12345",
  payload: { progress: 4 },
};

describe("durable provider write queue", () => {
  afterEach(async () => {
    const queue = new DurableProviderWriteQueue();
    for (const job of await queue.list()) await queue.remove(job.id);
  });

  it("persists jobs and retries transient failures with backoff", async () => {
    const first = new DurableProviderWriteQueue();
    const job = await first.enqueue(sample);
    const second = new DurableProviderWriteQueue();
    expect((await second.list()).map(item => item.id)).toContain(job.id);
    const result = await second.process(async () => { throw new Error("offline"); }, { now: Date.now() + 1 });
    expect(result.failed).toBe(1);
    const saved = (await first.list())[0]!;
    expect(saved.state).toBe("pending");
    expect(saved.attempts).toBe(1);
    expect(saved.lastError).toBe("offline");
  });

  it("removes a job after successful execution", async () => {
    const queue = new DurableProviderWriteQueue();
    await queue.enqueue(sample);
    const result = await queue.process(async () => undefined, { now: Date.now() + 1 });
    expect(result.succeeded).toBe(1);
    expect(await queue.list()).toHaveLength(0);
  });

  it("rejects unsafe title URLs and invalid progress", async () => {
    const queue = new DurableProviderWriteQueue();
    await expect(queue.enqueue({ ...sample, titleUrl: "https://example.com/anime/12345" })).rejects.toThrow();
    await expect(queue.enqueue({ ...sample, payload: { progress: -1 } })).rejects.toThrow();
  });

  it("allows explicitly retrying terminal failures", async () => {
    const queue = new DurableProviderWriteQueue();
    await queue.enqueue(sample);
    for (let attempt = 0; attempt < 12; attempt++) {
      await queue.process(async () => { throw new Error("rejected"); }, { now: Date.now() + 100_000_000 });
    }
    const failed = (await queue.list()).find(job => job.state === "failed");
    expect(failed).toBeTruthy();
    expect(await queue.retryFailed()).toBe(1);
    expect((await queue.list())[0]?.state).toBe("pending");
  });
});
