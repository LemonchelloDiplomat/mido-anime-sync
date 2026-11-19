import { describe, expect, it, vi } from "vitest";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  SyncDeletionIntent,
  SyncOperation,
} from "../src/core/types.js";
import { canAdvanceSyncBaseline } from "../src/core/bidirectional-sync.js";
import {
  executeRemoteDeletions,
  resolvePendingRemoteDeletionIntents,
} from "../src/core/remote-deletion.js";

function anime(id = "local:1"): AnimeIdentity {
  return {
    id,
    titles: { english: "Example anime", synonyms: [] },
    externalIds: { myanimelist: "100", anilist: "200" },
  };
}

function entry(animeId = "local:1"): AnimeListEntry {
  return {
    animeId,
    source: "myanimelist",
    status: "WATCHING",
    progress: 4,
    score: null,
    favorite: false,
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

function intent(): SyncDeletionIntent {
  const item = anime();
  const providerEntry = entry(item.id);
  return {
    id: "delete-mal-local:1",
    provider: "mal",
    animeId: item.id,
    externalId: "100",
    anime: item,
    entry: providerEntry,
    createdAt: "2026-11-17T10:00:00.000Z",
  };
}

function operation(id = "sync-1-remote-delete-0"): SyncOperation {
  return {
    id,
    sessionId: id.split("-remote-delete-")[0] ?? "sync-1",
    provider: "mal",
    direction: "remote",
    kind: "delete",
    animeId: "local:1",
    externalId: "100",
    entry: entry(),
    anime: anime(),
    status: "pending",
    attempts: 0,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

function remoteSnapshot(includeEntry = true): AnimeSnapshotV4 {
  const remoteAnime = anime("mal:100");
  const remoteEntry = { ...entry(remoteAnime.id), source: "myanimelist" as const };
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-17T10:00:00.000Z",
    anime: includeEntry ? [remoteAnime] : [],
    entries: includeEntry ? [remoteEntry] : [],
    sourceEntries: includeEntry ? [remoteEntry] : [],
    conflictResolutions: [],
    animeRelations: [],
  };
}

describe("safe remote deletion workflow", () => {
  it("keeps the deletion intent and blocks baseline advancement when the provider rejects deletion", async () => {
    const pending = new Map([[intent().id, intent()]]);
    const journal = new Map([[operation().id, operation()]]);
    const candidates = await resolvePendingRemoteDeletionIntents(
      [...pending.values()],
      remoteSnapshot(),
      "mal",
      async (id) => { pending.delete(id); },
    );

    const result = await executeRemoteDeletions("mal", candidates, [...journal.values()], {
      deleteAccountEntry: vi.fn().mockRejectedValue(new Error("MAL returned HTTP 503")),
      deleteDeletionIntent: async (id) => { pending.delete(id); },
      updateSyncOperation: async (id, update) => {
        journal.set(id, { ...journal.get(id)!, ...update });
      },
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(pending.has("delete-mal-local:1")).toBe(true);
    expect(journal.get(operation().id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "MAL returned HTTP 503",
    });
    expect(canAdvanceSyncBaseline(result.failures.length, 0)).toBe(false);
  });

  it("retries a failed deletion on the next sync and clears the intent only after success", async () => {
    const pending = new Map([[intent().id, intent()]]);
    const firstOperation = operation("sync-first-remote-delete-0");
    const firstCandidates = await resolvePendingRemoteDeletionIntents(
      [...pending.values()],
      remoteSnapshot(),
      "mal",
      async (id) => { pending.delete(id); },
    );

    await executeRemoteDeletions("mal", firstCandidates, [firstOperation], {
      deleteAccountEntry: vi.fn().mockRejectedValue(new Error("temporary failure")),
      deleteDeletionIntent: async (id) => { pending.delete(id); },
      updateSyncOperation: async () => undefined,
    });

    expect(pending.has(intent().id)).toBe(true);

    const retryOperation = operation("sync-retry-remote-delete-0");
    const retryCandidates = await resolvePendingRemoteDeletionIntents(
      [...pending.values()],
      remoteSnapshot(),
      "mal",
      async (id) => { pending.delete(id); },
    );
    const deleteAccountEntry = vi.fn().mockResolvedValue(undefined);
    const journal = new Map([[retryOperation.id, retryOperation]]);

    const retryResult = await executeRemoteDeletions("mal", retryCandidates, [retryOperation], {
      deleteAccountEntry,
      deleteDeletionIntent: async (id) => { pending.delete(id); },
      updateSyncOperation: async (id, update) => {
        journal.set(id, { ...journal.get(id)!, ...update });
      },
    });

    expect(deleteAccountEntry).toHaveBeenCalledWith("mal", { externalId: "100" });
    expect(retryResult).toMatchObject({ succeeded: 1, deleted: 1, failures: [] });
    expect(pending.size).toBe(0);
    expect(journal.get(retryOperation.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });

  it("clears a pending intent without another API delete when the remote entry is already gone", async () => {
    const pending = new Map([[intent().id, intent()]]);
    const deleteDeletionIntent = vi.fn(async (id: string) => { pending.delete(id); });

    const candidates = await resolvePendingRemoteDeletionIntents(
      [...pending.values()],
      remoteSnapshot(false),
      "mal",
      deleteDeletionIntent,
    );

    expect(candidates).toEqual([]);
    expect(deleteDeletionIntent).toHaveBeenCalledWith(intent().id);
    expect(pending.size).toBe(0);
  });

  it("does not clear an intent merely because a remote snapshot has the anime without its list entry", async () => {
    const pending = new Map([[intent().id, intent()]]);
    const snapshot = remoteSnapshot(false);
    snapshot.anime = [anime("mal:100")];

    const deleteDeletionIntent = vi.fn(async (id: string) => { pending.delete(id); });
    const candidates = await resolvePendingRemoteDeletionIntents(
      [...pending.values()],
      snapshot,
      "mal",
      deleteDeletionIntent,
    );

    expect(candidates).toEqual([]);
    expect(deleteDeletionIntent).toHaveBeenCalledWith(intent().id);
    expect(pending.size).toBe(0);
  });
});
