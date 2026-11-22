import { describe, expect, it, vi } from "vitest";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  SyncOperation,
} from "../src/core/types.js";
import { reconcileUnfinishedSyncOperations } from "../src/core/sync-recovery.js";

function anime(id = "remote:100"): AnimeIdentity {
  return {
    id,
    titles: { english: "Example anime", synonyms: [] },
    externalIds: { myanimelist: "100", anilist: "200" },
  };
}

function entry(
  animeId = "remote:100",
  source: "myanimelist" | "anilist" | "local" = "myanimelist",
): AnimeListEntry {
  return {
    animeId,
    source,
    status: "WATCHING",
    progress: 4,
    score: 80,
    favorite: false,
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

function operation(
  overrides: Partial<SyncOperation> = {},
): SyncOperation {
  return {
    id: "sync-1-remote-delete-0",
    sessionId: "sync-1",
    provider: "mal",
    direction: "remote",
    kind: "delete",
    animeId: "local:1",
    externalId: "100",
    entry: entry("local:1"),
    status: "in_progress",
    attempts: 1,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function snapshot(includeEntry: boolean): AnimeSnapshotV4 {
  const remoteAnime = anime();
  const remoteEntry = entry(remoteAnime.id);
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-17T10:00:00.000Z",
    anime: [remoteAnime],
    entries: includeEntry ? [remoteEntry] : [],
    sourceEntries: includeEntry ? [remoteEntry] : [],
    conflictResolutions: [],
    animeRelations: [],
  };
}

describe("unfinished sync operation recovery", () => {
  it("marks a remote delete succeeded when the provider entry disappeared before the app closed", async () => {
    const update = vi.fn(async () => undefined);
    const result = await reconcileUnfinishedSyncOperations(
      [operation()],
      "mal",
      snapshot(false),
      {
        getSourceEntries: vi.fn(async () => []),
        updateSyncOperation: update,
      },
    );

    expect(result.recoveredOperations).toBe(1);
    expect(update).toHaveBeenCalledWith(operation().id, { status: "succeeded" });
  });

  it("does not treat a remote delete as successful when the provider entry is still present", async () => {
    const update = vi.fn(async () => undefined);
    const result = await reconcileUnfinishedSyncOperations(
      [operation()],
      "mal",
      snapshot(true),
      {
        getSourceEntries: vi.fn(async () => []),
        updateSyncOperation: update,
      },
    );

    expect(result.recoveredOperations).toBe(0);
    expect(update).toHaveBeenCalledWith(operation().id, expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("текущее состояние не совпадает"),
    }));
  });

  it("marks a local delete succeeded when its source entry is already absent", async () => {
    const localDelete = operation({
      id: "sync-2-local-delete-0",
      sessionId: "sync-2",
      direction: "local",
      animeId: "local:1",
      entry: entry("local:1", "myanimelist"),
    });
    const update = vi.fn(async () => undefined);
    const getSourceEntries = vi.fn(async () => [] as AnimeListEntry[]);

    const result = await reconcileUnfinishedSyncOperations(
      [localDelete],
      "mal",
      snapshot(true),
      { getSourceEntries, updateSyncOperation: update },
    );

    expect(result.recoveredOperations).toBe(1);
    expect(getSourceEntries).toHaveBeenCalledWith("local:1");
    expect(update).toHaveBeenCalledWith(localDelete.id, { status: "succeeded" });
  });

  it("does not treat a local delete as successful while its source entry remains", async () => {
    const localDelete = operation({
      id: "sync-3-local-delete-0",
      sessionId: "sync-3",
      direction: "local",
      entry: entry("local:1", "myanimelist"),
    });
    const update = vi.fn(async () => undefined);

    const result = await reconcileUnfinishedSyncOperations(
      [localDelete],
      "mal",
      snapshot(true),
      {
        getSourceEntries: async () => [entry("local:1", "myanimelist")],
        updateSyncOperation: update,
      },
    );

    expect(result.recoveredOperations).toBe(0);
    expect(update).toHaveBeenCalledWith(localDelete.id, expect.objectContaining({ status: "failed" }));
  });

  it("compares MAL scores after provider rounding when recovering updates", async () => {
    const updateOperation = operation({
      id: "sync-4-remote-update-0",
      sessionId: "sync-4",
      kind: "update",
      entry: { ...entry(), score: 84 },
    });
    const update = vi.fn(async () => undefined);

    const result = await reconcileUnfinishedSyncOperations(
      [updateOperation],
      "mal",
      snapshot(true),
      {
        getSourceEntries: async () => [],
        updateSyncOperation: update,
      },
    );

    expect(result.recoveredOperations).toBe(1);
    expect(update).toHaveBeenCalledWith(updateOperation.id, { status: "succeeded" });
  });
});


describe("Shikimori sync recovery", () => {

  it("does not mark a Shikimori update recovered when provider metadata differs", async () => {
    const remoteAnime: AnimeIdentity = {
      id: "shikimori:41",
      titles: { english: "Example anime", synonyms: [] },
      externalIds: { shikimori: "41" },
    };
    const expected = {
      ...entry(remoteAnime.id, "local"),
      source: "shikimori" as const,
      sourceMetadata: { shikimoriRateId: 901, rewatches: 3, text: "keep this note" },
    };
    const actual = { ...expected, sourceMetadata: { ...expected.sourceMetadata, text: "old note" } };
    const updateOperation = operation({
      id: "sync-shikimori-metadata",
      sessionId: "sync-shikimori-metadata",
      provider: "shikimori",
      kind: "update",
      externalId: "41",
      entry: expected,
    });
    const update = vi.fn(async () => undefined);
    const result = await reconcileUnfinishedSyncOperations(
      [updateOperation],
      "shikimori",
      {
        schemaVersion: 4,
        exportedAt: "2026-11-17T10:00:00.000Z",
        anime: [remoteAnime],
        entries: [actual],
        sourceEntries: [actual],
        conflictResolutions: [],
        animeRelations: [],
      },
      { getSourceEntries: vi.fn(async () => []), updateSyncOperation: update },
    );

    expect(result.recoveredOperations).toBe(0);
    expect(update).toHaveBeenCalledWith(updateOperation.id, expect.objectContaining({ status: "failed" }));
  });

  it("compares scores at Shikimori's ten-point precision", async () => {
    const remoteAnime: AnimeIdentity = {
      id: "shikimori:41",
      titles: { english: "Example anime", synonyms: [] },
      externalIds: { shikimori: "41" },
    };
    const remoteEntry: AnimeListEntry = {
      animeId: remoteAnime.id,
      source: "shikimori",
      status: "WATCHING",
      progress: 4,
      score: 80,
      favorite: false,
      updatedAt: "2026-11-17T10:00:00.000Z",
      sourceMetadata: { shikimoriRateId: 901 },
    };
    const updateOperation = operation({
      id: "sync-shikimori-remote-update-0",
      sessionId: "sync-shikimori",
      provider: "shikimori",
      kind: "update",
      animeId: remoteAnime.id,
      externalId: "41",
      entry: { ...remoteEntry, score: 84 },
    });
    const update = vi.fn(async () => undefined);
    const result = await reconcileUnfinishedSyncOperations(
      [updateOperation],
      "shikimori",
      {
        schemaVersion: 4,
        exportedAt: "2026-11-17T10:00:00.000Z",
        anime: [remoteAnime],
        entries: [remoteEntry],
        sourceEntries: [remoteEntry],
        conflictResolutions: [],
        animeRelations: [],
      },
      {
        getSourceEntries: vi.fn(async () => []),
        updateSyncOperation: update,
      },
    );

    expect(result.recoveredOperations).toBe(1);
    expect(update).toHaveBeenCalledWith(updateOperation.id, { status: "succeeded" });
  });
});
