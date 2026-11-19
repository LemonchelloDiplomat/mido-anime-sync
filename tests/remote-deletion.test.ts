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

  it("clears the intent when the remote anime remains in the catalog but its list entry is gone", async () => {
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


describe("Shikimori remote deletion", () => {
  it("uses the persisted Shikimori rate ID for idempotent deletion", async () => {
    const deletedAnime: AnimeIdentity = {
      id: "local:shikimori:41",
      titles: { english: "Example anime", synonyms: [] },
      externalIds: { shikimori: "41" },
    };
    const deletedEntry: AnimeListEntry = {
      animeId: deletedAnime.id,
      source: "shikimori",
      status: "WATCHING",
      progress: 4,
      score: 80,
      favorite: false,
      updatedAt: "2026-11-17T10:00:00.000Z",
    };
    const deletionIntent: SyncDeletionIntent = {
      id: "delete-shikimori-41",
      provider: "shikimori",
      animeId: deletedAnime.id,
      externalId: "41",
      anime: deletedAnime,
      entry: deletedEntry,
      createdAt: "2026-11-17T10:00:00.000Z",
    };
    const remoteAnime: AnimeIdentity = {
      ...deletedAnime,
      id: "shikimori:41",
    };
    const remoteEntry: AnimeListEntry = {
      ...deletedEntry,
      animeId: remoteAnime.id,
      source: "shikimori",
      sourceMetadata: { shikimoriRateId: 901 },
    };
    const snapshot: AnimeSnapshotV4 = {
      schemaVersion: 4,
      exportedAt: "2026-11-17T10:00:00.000Z",
      anime: [remoteAnime],
      entries: [remoteEntry],
      sourceEntries: [remoteEntry],
      conflictResolutions: [],
      animeRelations: [],
    };
    const candidates = await resolvePendingRemoteDeletionIntents(
      [deletionIntent],
      snapshot,
      "shikimori",
      vi.fn(async () => undefined),
    );
    expect(candidates[0]?.entryId).toBe(901);

    const shikimoriOperation: SyncOperation = {
      ...operation(),
      id: "sync-shikimori-remote-delete-0",
      sessionId: "sync-shikimori",
      provider: "shikimori",
      animeId: deletedAnime.id,
      externalId: "41",
      entry: deletedEntry,
      anime: deletedAnime,
    };
    const deleteAccountEntry = vi.fn(async () => ({ ok: true }));
    const result = await executeRemoteDeletions(
      "shikimori",
      candidates,
      [shikimoriOperation],
      {
        deleteAccountEntry,
        deleteDeletionIntent: vi.fn(async () => undefined),
        updateSyncOperation: vi.fn(async () => undefined),
      },
    );

    expect(deleteAccountEntry).toHaveBeenCalledWith("shikimori", {
      externalId: "41",
      entryId: 901,
    });
    expect(result).toMatchObject({ succeeded: 1, deleted: 1, failures: [] });
  });
});
