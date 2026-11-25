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
    indexes: { "by-state": ProviderWriteState; "by-next-attempt": number; "by-created": string };
  };
}

const DATABASE_NAME = "mido-anime-sync-provider-write-queue";
const DATABASE_VERSION = 1;
const STORE_NAME = "jobs";
const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

let databasePromise: Promise<IDBPDatabase<QueueSchema>> | null = null;

function database(): Promise<IDBPDatabase<QueueSchema>> {
  if (!databasePromise) {
    databasePromise = openDB<QueueSchema>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("by-state", "state");
          store.createIndex("by-next-attempt", "nextAttemptAt");
          store.createIndex("by-created", "createdAt");
        }
      },
    });
  }
  return databasePromise;
}

function validate(input: Omit<ProviderWriteJob, "id" | "state" | "attempts" | "createdAt" | "updatedAt" | "nextAttemptAt" | "lastError">): void {
  if (!/^\\d+$/.test(input.externalId)) throw new Error("AnimeGO external ID must be numeric.");
  const url = new URL(input.titleUrl);
  if (url.protocol !== "https:" || url.hostname !== "animego.me" || !/^\\/anime\\/[^/]+-\\d+\\/?$/.test(url.pathname)) {
    throw new Error("AnimeGO title URL is invalid.");
  }
  if (input.kind === "rating" && (!Number.isInteger(input.payload.rating) || input.payload.rating! < 1 || input.payload.rating! > 10)) {
    throw new Error("Rating must be an integer from 1 to 10.");
  }
  if (input.kind === "progress" && (!Number.isSafeInteger(input.payload.progress) || input.payload.progress! < 0)) {
    throw new Error("Progress must be a non-negative integer.");
  }
  if (input.kind === "status" && !input.payload.status) throw new Error("Status is required.");
}

export class DurableProviderWriteQueue {
  async enqueue(input: Omit<ProviderWriteJob, "id" | "state" | "attempts" | "createdAt" | "updatedAt" | "nextAttemptAt" | "lastError">): Promise<ProviderWriteJob> {
    validate(input);
    const now = new Date().toISOString();
    const job: ProviderWriteJob = {
      ...input, id: crypto.randomUUID(), state: "pending", attempts: 0,
      createdAt: now, updatedAt: now, nextAttemptAt: Date.now(), lastError: null,
    };
    await (await database()).put(STORE_NAME, job);
    return job;
  }

  async list(): Promise<ProviderWriteJob[]> {
    return (await database()).getAllFromIndex(STORE_NAME, "by-created");
  }

  async pendingCount(): Promise<number> {
    return (await database()).countFromIndex(STORE_NAME, "by-state", "pending");
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
      job.nextAttemptAt = Date.now();
      job.updatedAt = now;
      job.lastError = null;
      await tx.store.put(job);
    }
    await tx.done;
    return jobs.length;
  }

  async process(execute: (job: ProviderWriteJob) => Promise<void>, options: { now?: number; limit?: number } = {}): Promise<{ succeeded: number; failed: number; deferred: number }> {
    const nowMs = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const db = await database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const pending = await tx.store.index("by-state").getAll("pending");
    const ready = pending.filter(job => job.nextAttemptAt <= nowMs).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    for (const job of ready) {
      job.state = "processing";
      job.updatedAt = new Date(nowMs).toISOString();
      await tx.store.put(job);
    }
    await tx.done;

    let succeeded = 0, failed = 0;
    for (const job of ready) {
      try {
        await execute(job);
        await db.delete(STORE_NAME, job.id);
        succeeded++;
      } catch (error) {
        const attempts = job.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 16));
        const updated: ProviderWriteJob = {
          ...job, attempts, state: terminal ? "failed" : "pending",
          updatedAt: new Date().toISOString(),
          nextAttemptAt: Date.now() + delay,
          lastError: error instanceof Error ? error.message.slice(0, 500) : "Provider write failed.",
        };
        await db.put(STORE_NAME, updated);
        failed++;
      }
    }
    return { succeeded, failed, deferred: pending.length - ready.length };
  }
}

export const animeGoProviderWriteQueue = new DurableProviderWriteQueue();
