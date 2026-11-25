import { openDB, type IDBPDatabase } from "idb";
import type { AnimeStatus } from "../core/types.js";

export type ProviderWriteKind = "rating" | "status" | "progress" | "delete";
export type ProviderWriteState = "pending" | "processing" | "failed";

export interface ProviderWritePayload {
  rating?: number;
  status?: AnimeStatus;
  progress?: number;
}

export interface ProviderWriteJob {
  id: string;
  provider: "animego";
  kind: ProviderWriteKind;
  externalId: string;
  titleUrl: string;
  payload: ProviderWritePayload;
  state: ProviderWriteState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: number;
  lastError: string | null;
}

interface QueueSchema {
  jobs: {
    key: string;
    value: ProviderWriteJob;
    indexes: { "by-state": ProviderWriteState; "by-created": string };
  };
}

const DATABASE_NAME = "mido-anime-sync-provider-write-queue";
const DATABASE_VERSION = 1;
const STORE_NAME = "jobs";
const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
// A second app window must not steal work from a tab that is still executing it.
// A two-minute lease recovers jobs left behind by a crash or forced shutdown.
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
let databasePromise: Promise<IDBPDatabase<QueueSchema>> | null = null;

function database(): Promise<IDBPDatabase<QueueSchema>> {
  if (!databasePromise) {
    databasePromise = openDB<QueueSchema>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("by-state", "state");
          store.createIndex("by-created", "createdAt");
        }
      },
      blocked() { databasePromise = null; },
      terminated() { databasePromise = null; },
    });
  }
  return databasePromise;
}

type NewProviderWriteJob = Pick<ProviderWriteJob, "provider" | "kind" | "externalId" | "titleUrl" | "payload">;

function validate(input: NewProviderWriteJob): void {
  if (input.provider !== "animego") throw new Error("Unsupported provider.");
  if (!/^\d+$/.test(input.externalId)) throw new Error("AnimeGO external ID must be numeric.");
  let url: URL;
  try { url = new URL(input.titleUrl); } catch { throw new Error("AnimeGO title URL is invalid."); }
  if (url.protocol !== "https:" || url.hostname !== "animego.me" || !/^\/anime\/[^/]+-\d+\/?$/.test(url.pathname)) {
    throw new Error("AnimeGO title URL is invalid.");
  }
  const urlId = url.pathname.match(/-(\d+)\/?$/)?.[1];
  if (urlId !== input.externalId) throw new Error("AnimeGO title URL and external ID do not match.");
  if (input.kind === "rating" && (!Number.isInteger(input.payload.rating) || input.payload.rating! < 1 || input.payload.rating! > 10)) {
    throw new Error("Rating must be an integer from 1 to 10.");
  }
  if (input.kind === "progress" && (!Number.isSafeInteger(input.payload.progress) || input.payload.progress! < 0)) {
    throw new Error("Progress must be a non-negative integer.");
  }
  if (input.kind === "status" && !["PLANNING", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED", "REWATCHING"].includes(input.payload.status ?? "")) {
    throw new Error("Status is invalid.");
  }
  if (input.kind === "delete" && Object.keys(input.payload).length) throw new Error("Delete jobs cannot contain a mutation payload.");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider write failed.";
  return message.replace(/(token|cookie|authorization|password)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]").slice(0, 500);
}

export class DurableProviderWriteQueue {
  async enqueue(input: NewProviderWriteJob): Promise<ProviderWriteJob> {
    validate(input);
    const now = new Date().toISOString();
    const job: ProviderWriteJob = {
      ...structuredClone(input), id: crypto.randomUUID(), state: "pending", attempts: 0,
      createdAt: now, updatedAt: now, nextAttemptAt: Date.now(), lastError: null,
    };
    const db = await database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const pending = await tx.store.index("by-state").getAll("pending");
    for (const previous of pending) {
      if (previous.provider === job.provider && previous.externalId === job.externalId &&
          (previous.kind === job.kind || job.kind === "delete")) {
        // A confirmed local delete supersedes every pending write for the same
        // remote title. Never replay progress/status/rating after deletion.
        await tx.store.delete(previous.id);
      }
    }
    await tx.store.put(job);
    await tx.done;
    return job;
  }

  async list(): Promise<ProviderWriteJob[]> {
    return (await database()).getAllFromIndex(STORE_NAME, "by-created");
  }

  async pendingCount(): Promise<number> {
    return (await database()).countFromIndex(STORE_NAME, "by-state", "pending");
  }

  async nextPendingAt(): Promise<number | null> {
    const db = await database();
    const [pending, processing] = await Promise.all([
      db.getAllFromIndex(STORE_NAME, "by-state", "pending"),
      db.getAllFromIndex(STORE_NAME, "by-state", "processing"),
    ]);
    const deadlines = [
      ...pending.map(job => job.nextAttemptAt),
      ...processing.map(job => {
        const startedAt = Date.parse(job.updatedAt);
        return (Number.isFinite(startedAt) ? startedAt : Date.now()) + PROCESSING_LEASE_MS;
      }),
    ];
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  async remove(id: string): Promise<void> {
    await (await database()).delete(STORE_NAME, id);
  }

  async retryFailed(): Promise<number> {
    const db = await database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const jobs = await tx.store.index("by-state").getAll("failed");
    const now = new Date().toISOString();
    for (const job of jobs) {
      job.state = "pending";
      job.attempts = 0;
      job.nextAttemptAt = Date.now();
      job.updatedAt = now;
      job.lastError = null;
      await tx.store.put(job);
    }
    await tx.done;
    return jobs.length;
  }

  async recoverInterrupted(nowMs = Date.now()): Promise<number> {
    const db = await database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const jobs = await tx.store.index("by-state").getAll("processing");
    const now = new Date(nowMs).toISOString();
    const stale = jobs.filter(job => {
      const processingSince = Date.parse(job.updatedAt);
      return !Number.isFinite(processingSince) || nowMs - processingSince >= PROCESSING_LEASE_MS;
    });
    for (const job of stale) {
      job.state = "pending";
      job.nextAttemptAt = nowMs;
      job.updatedAt = now;
      job.lastError = "Recovered after application restart; remote state must be checked before replay.";
      await tx.store.put(job);
    }
    await tx.done;
    return stale.length;
  }

  async process(
    execute: (job: ProviderWriteJob) => Promise<void>,
    options: { now?: number; limit?: number } = {},
  ): Promise<{ succeeded: number; failed: number; deferred: number }> {
    const nowMs = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const db = await database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const pending = await tx.store.index("by-state").getAll("pending");
    const ready = pending.filter(job => job.nextAttemptAt <= nowMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    for (const job of ready) {
      job.state = "processing";
      job.updatedAt = new Date(nowMs).toISOString();
      await tx.store.put(job);
    }
    await tx.done;

    let succeeded = 0;
    let failed = 0;
    for (const job of ready) {
      try {
        await execute(structuredClone(job));
        await db.delete(STORE_NAME, job.id);
        succeeded++;
      } catch (error) {
        const attempts = job.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 16));
        await db.put(STORE_NAME, {
          ...job,
          attempts,
          state: terminal ? "failed" : "pending",
          updatedAt: new Date().toISOString(),
          nextAttemptAt: Date.now() + delay,
          lastError: safeError(error),
        });
        failed++;
      }
    }
    return { succeeded, failed, deferred: pending.length - ready.length };
  }
}

export class ProviderWriteQueueRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakePromise: Promise<void> | null = null;
  private readonly onOnline = () => { void this.wake(); };
  private readonly onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") void this.wake();
  };

  constructor(
    private readonly queue: DurableProviderWriteQueue,
    private readonly execute: (job: ProviderWriteJob) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    await this.wake();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
  }

  async wake(): Promise<void> {
    if (!this.running || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    if (this.wakePromise) return this.wakePromise;

    this.wakePromise = this.processAndSchedule();
    try {
      await this.wakePromise;
    } finally {
      this.wakePromise = null;
    }
  }

  private async processAndSchedule(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.queue.recoverInterrupted();
    // Keep the processing lease bounded even when many writes are queued.
    await this.queue.process(this.execute, { limit: 1 });
    if (!this.running) return;
    const nextAttemptAt = await this.queue.nextPendingAt();
    if (nextAttemptAt !== null) {
      const delay = Math.max(1_000, Math.min(6 * 60 * 60 * 1000, nextAttemptAt - Date.now()));
      this.timer = setTimeout(() => { void this.wake(); }, delay);
    }
  }
}

export const animeGoProviderWriteQueue = new DurableProviderWriteQueue();
