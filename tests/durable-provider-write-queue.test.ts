import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableProviderWriteQueue, ProviderWriteQueueRunner } from "../src/services/durable-provider-write-queue.js";

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

  it("coalesces superseded pending writes for the same title and operation", async () => {
    const queue = new DurableProviderWriteQueue();
    const first = await queue.enqueue(sample);
    const second = await queue.enqueue({ ...sample, payload: { progress: 8 } });
    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(second.id);
    expect(jobs[0]?.payload.progress).toBe(8);
    expect(jobs[0]?.id).not.toBe(first.id);
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

  it("recovers jobs left processing by an application crash", async () => {
    const queue = new DurableProviderWriteQueue();
    const job = await queue.enqueue(sample);
    const db = await import("idb");
    const handle = await db.openDB("mido-anime-sync-provider-write-queue", 1);
    const interrupted = { ...job, state: "processing" as const, updatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() };
    await handle.put("jobs", interrupted);
    handle.close();

    expect(await queue.recoverInterrupted()).toBe(1);
    const recovered = (await queue.list())[0]!;
    expect(recovered.state).toBe("pending");
    expect(recovered.lastError).toContain("restart");
  });

  it("schedules recovery at the end of a processing lease", async () => {
    const queue = new DurableProviderWriteQueue();
    const job = await queue.enqueue(sample);
    const startedAt = Date.now() - 30_000;
    const db = await import("idb");
    const handle = await db.openDB("mido-anime-sync-provider-write-queue", 1);
    await handle.put("jobs", {
      ...job,
      state: "processing" as const,
      updatedAt: new Date(startedAt).toISOString(),
    });
    handle.close();

    expect(await queue.nextPendingAt()).toBe(startedAt + 2 * 60 * 1000);
  });

  it("processes one provider write per runner batch to keep leases short", async () => {
    const queue = new DurableProviderWriteQueue();
    await queue.enqueue(sample);
    await queue.enqueue({ ...sample, externalId: "12346", titleUrl: "https://animego.me/anime/example-12346" });
    let executions = 0;

    const result = await queue.process(async () => { executions += 1; }, { limit: 1, now: Date.now() + 1 });

    expect(result.succeeded).toBe(1);
    expect(executions).toBe(1);
    expect(await queue.list()).toHaveLength(1);
  });

  it("does not recover a fresh processing job owned by another window", async () => {
    const queue = new DurableProviderWriteQueue();
    const job = await queue.enqueue(sample);
    const db = await import("idb");
    const handle = await db.openDB("mido-anime-sync-provider-write-queue", 1);
    await handle.put("jobs", { ...job, state: "processing" as const, updatedAt: new Date().toISOString() });
    handle.close();

    expect(await queue.recoverInterrupted()).toBe(0);
    expect((await queue.list())[0]?.state).toBe("processing");
  });

  it("serializes overlapping runner wakeups into one queue execution", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const queue = new DurableProviderWriteQueue();
    await queue.enqueue(sample);
    let executions = 0;
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
    const runner = new ProviderWriteQueueRunner(queue, async () => {
      executions += 1;
      await executionGate;
    });

    const starting = runner.start();
    await Promise.resolve();
    await Promise.resolve();
    const overlappingWake = runner.wake();
    releaseExecution();
    await Promise.all([starting, overlappingWake]);

    expect(executions).toBe(1);
    expect(await queue.list()).toHaveLength(0);
    runner.stop();
    vi.unstubAllGlobals();
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
    expect((await queue.list())[0]).toMatchObject({ state: "pending", attempts: 0, lastError: null });
  });
});
