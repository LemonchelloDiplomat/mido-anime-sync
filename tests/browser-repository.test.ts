import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { BrowserAnimeRepository } from "../src/storage/browser-repository.js";
import { createImportPreview } from "../src/core/import-preview.js";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeRelation,
  AnimeSnapshot,
  SyncOperation,
  SyncSession,
  SyncDeletionIntent,
} from "../src/core/types.js";

const repositories: BrowserAnimeRepository[] = [];

async function createRepository(): Promise<BrowserAnimeRepository> {
  const name = `anime-sync-test-${Date.now()}-${Math.random()}`;
  const repository = await BrowserAnimeRepository.open(name);

  repositories.push(repository);

  return repository;
}

function makeAnime(id: string): AnimeIdentity {
  return {
    id,
    titles: {
      english: `Anime ${id}`,
      synonyms: [],
    },
    externalIds: {},
    episodes: 12,
  };
}

function makeEntry(
  animeId: string,
  progress: number,
  updatedAt: string,
): AnimeListEntry {
  return {
    animeId,
    status: progress >= 12 ? "COMPLETED" : "WATCHING",
    progress,
    score: null,
    favorite: false,
    updatedAt,
    source: "myanimelist",
  };
}

function makeSnapshot(ids: string[], progress = 3): AnimeSnapshot {
  const entries = ids.map((id) =>
    makeEntry(id, progress, "2026-11-15T12:00:00.000Z"),
  );

  return {
    schemaVersion: 2,
    exportedAt: "2026-11-15T12:00:00.000Z",
    anime: ids.map(makeAnime),
    entries,
    sourceEntries: entries,
  };
}

async function createStatusConflict(
  repo: BrowserAnimeRepository,
  animeId: string,
): Promise<void> {
  await repo.saveAnime(makeAnime(animeId));

  await repo.saveSourceEntry({
    animeId,
    source: "myanimelist",
    progress: 8,
    status: "COMPLETED",
    score: null,
    favorite: false,
    updatedAt: "2026-11-14T12:00:00.000Z",
  });

  await repo.saveSourceEntry({
    animeId,
    source: "anilist",
    progress: 8,
    status: "WATCHING",
    score: null,
    favorite: false,
    updatedAt: "2026-11-15T12:00:00.000Z",
  });
}

afterEach(() => {
  for (const repository of repositories) {
    repository.close();
  }

  repositories.length = 0;
});

describe("BrowserAnimeRepository merge", () => {
  it("saves provider baselines as one atomic batch", async () => {
    const repo = await createRepository();
    await repo.saveAnime(makeAnime("one"));
    await repo.saveAnime(makeAnime("two"));

    await repo.saveSourceEntries([
      makeEntry("one", 3, "2026-11-15T12:00:00.000Z"),
      makeEntry("two", 5, "2026-11-15T12:00:00.000Z"),
    ]);

    expect(await repo.getSourceEntries("one")).toHaveLength(1);
    expect(await repo.getSourceEntries("two")).toHaveLength(1);
  });

  it("rolls back the whole baseline batch if one anime is missing", async () => {
    const repo = await createRepository();
    await repo.saveAnime(makeAnime("exists"));

    await expect(repo.saveSourceEntries([
      makeEntry("exists", 3, "2026-11-15T12:00:00.000Z"),
      makeEntry("missing", 5, "2026-11-15T12:00:00.000Z"),
    ])).rejects.toThrow("Unknown animeId: missing");

    expect(await repo.getSourceEntries("exists")).toHaveLength(0);
  });

  it("preserves existing anime and adds new anime", async () => {
    const repo = await createRepository();

    for (let i = 1; i <= 10; i++) {
      const anime = makeAnime(`anime-${i}`);

      await repo.saveAnime(anime);
      await repo.saveEntry(makeEntry(anime.id, 3, "2026-11-14T12:00:00.000Z"));
    }

    await repo.mergeSnapshot(
      makeSnapshot(["anime-11", "anime-12", "anime-13"]),
    );

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(13);
    expect(snapshot.entries).toHaveLength(13);
    expect(snapshot.anime.map((anime) => anime.id)).toContain("anime-1");
    expect(snapshot.anime.map((anime) => anime.id)).toContain("anime-13");
  });

  it("updates matching entries without deleting other anime", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("shared"));
    await repo.saveAnime(makeAnime("keep"));

    await repo.saveEntry(makeEntry("shared", 3, "2026-11-14T12:00:00.000Z"));
    await repo.saveEntry(makeEntry("keep", 5, "2026-11-14T12:00:00.000Z"));

    const incoming = makeSnapshot(["shared"], 7);

    incoming.sourceEntries[0]!.updatedAt = "2026-11-15T12:00:00.000Z";
    incoming.entries[0]!.updatedAt = "2026-11-15T12:00:00.000Z";

    await repo.mergeSnapshot(incoming);

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(2);
    expect(snapshot.entries).toHaveLength(2);

    expect(await repo.getEntry("shared")).toMatchObject({
      progress: 7,
      status: "WATCHING",
    });

    expect(await repo.getEntry("keep")).toMatchObject({
      progress: 5,
    });
  });

  it("merges two anime records and preserves their source entries", async () => {
    const repo = await createRepository();

    const target: AnimeIdentity = {
      id: "target",
      titles: {
        english: "Death Note",
        synonyms: [],
      },
      externalIds: {
        myanimelist: "100",
      },
      episodes: 37,
    };

    const source: AnimeIdentity = {
      id: "source",
      titles: {
        romaji: "Desu Noto",
        synonyms: ["Death Note"],
      },
      externalIds: {
        anilist: "200",
      },
      episodes: 37,
    };

    await repo.saveAnime(target);
    await repo.saveAnime(source);

    await repo.saveSourceEntry({
      animeId: "target",
      source: "myanimelist",
      status: "WATCHING",
      progress: 5,
      score: 80,
      favorite: false,
      updatedAt: "2026-11-14T12:00:00.000Z",
    });

    await repo.saveSourceEntry({
      animeId: "source",
      source: "anilist",
      status: "WATCHING",
      progress: 8,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-15T12:00:00.000Z",
    });

    await repo.mergeAnimeRecords("source", "target");

    const mergedAnime = await repo.getAnime("target");

    expect(mergedAnime).toMatchObject({
      id: "target",
      titles: {
        english: "Death Note",
        romaji: "Desu Noto",
      },
      externalIds: {
        myanimelist: "100",
        anilist: "200",
      },
    });

    expect(await repo.getAnime("source")).toBeUndefined();
    expect(await repo.getEntry("source")).toBeUndefined();

    expect(await repo.getEntry("target")).toMatchObject({
      animeId: "target",
      progress: 8,
      score: 90,
      favorite: true,
    });

    const targetSources = await repo.getSourceEntries("target");

    expect(targetSources).toHaveLength(2);
    expect(targetSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "myanimelist",
          progress: 5,
        }),
        expect.objectContaining({
          source: "anilist",
          progress: 8,
        }),
      ]),
    );

    expect(await repo.getSourceEntries("source")).toHaveLength(0);

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.anime[0]?.id).toBe("target");
    expect(snapshot.sourceEntries).toHaveLength(2);
  });

  it("rejects merging different entries from the same service instead of losing one", async () => {
    const repo = await createRepository();

    const target = makeAnime("target");
    const source = makeAnime("source");

    await repo.saveAnime(target);
    await repo.saveAnime(source);

    await repo.saveSourceEntry({
      animeId: "target",
      source: "myanimelist",
      status: "WATCHING",
      progress: 3,
      score: 70,
      favorite: false,
      updatedAt: "2026-11-14T12:00:00.000Z",
    });

    await repo.saveSourceEntry({
      animeId: "source",
      source: "myanimelist",
      status: "WATCHING",
      progress: 9,
      score: 95,
      favorite: true,
      updatedAt: "2026-11-15T12:00:00.000Z",
    });

    await expect(repo.mergeAnimeRecords("source", "target")).rejects.toThrow(
      "both records contain different myanimelist source entries",
    );

    expect(await repo.getAnime("source")).toBeDefined();
    expect(await repo.getAnime("target")).toBeDefined();
    expect(await repo.getSourceEntries("source")).toHaveLength(1);
    expect(await repo.getSourceEntries("target")).toHaveLength(1);
  });

  it("does not merge records when external IDs conflict", async () => {
    const repo = await createRepository();

    const target: AnimeIdentity = {
      id: "target",
      titles: {
        english: "Anime Target",
        synonyms: [],
      },
      externalIds: {
        myanimelist: "100",
      },
    };

    const source: AnimeIdentity = {
      id: "source",
      titles: {
        english: "Anime Source",
        synonyms: [],
      },
      externalIds: {
        myanimelist: "999",
      },
    };

    await repo.saveAnime(target);
    await repo.saveAnime(source);

    await repo.saveSourceEntry({
      animeId: "target",
      source: "myanimelist",
      status: "WATCHING",
      progress: 3,
      score: null,
      favorite: false,
      updatedAt: "2026-11-14T12:00:00.000Z",
    });

    await repo.saveSourceEntry({
      animeId: "source",
      source: "anilist",
      status: "WATCHING",
      progress: 7,
      score: null,
      favorite: false,
      updatedAt: "2026-11-15T12:00:00.000Z",
    });

    await expect(repo.mergeAnimeRecords("source", "target")).rejects.toThrow(
      "External ID conflict for myanimelist",
    );

    expect(await repo.getAnime("target")).toBeDefined();
    expect(await repo.getAnime("source")).toBeDefined();

    expect(await repo.getEntry("target")).toMatchObject({
      progress: 3,
    });

    expect(await repo.getEntry("source")).toMatchObject({
      progress: 7,
    });

    expect(await repo.getSourceEntries("target")).toHaveLength(1);
    expect(await repo.getSourceEntries("source")).toHaveLength(1);
  });

  it("merges progress, score and favorite from different services", async () => {
    const repo = await createRepository();

    const anime = makeAnime("shared-anime");

    const malEntry: AnimeListEntry = {
      animeId: "shared-anime",
      status: "WATCHING",
      progress: 5,
      score: 70,
      favorite: true,
      updatedAt: "2026-11-14T12:00:00.000Z",
      source: "myanimelist",
    };

    const aniListEntry: AnimeListEntry = {
      animeId: "shared-anime",
      status: "WATCHING",
      progress: 8,
      score: 90,
      favorite: false,
      updatedAt: "2026-11-15T12:00:00.000Z",
      source: "anilist",
    };

    const snapshot: AnimeSnapshot = {
      schemaVersion: 2,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime: [anime],
      entries: [aniListEntry],
      sourceEntries: [malEntry, aniListEntry],
    };

    await repo.mergeSnapshot(snapshot);

    const result = await repo.getEntry("shared-anime");

    expect(result).toMatchObject({
      progress: 8,
      status: "WATCHING",
      score: 90,
      favorite: true,
    });

    const sources = await repo.getSourceEntries("shared-anime");

    expect(sources).toHaveLength(2);
  });

  it("detects status conflicts through the repository", async () => {
    const repo = await createRepository();

    await createStatusConflict(repo, "conflict-anime");

    const animeConflicts = await repo.getConflicts("conflict-anime");

    expect(animeConflicts).toHaveLength(1);
    expect(animeConflicts[0]).toMatchObject({
      animeId: "conflict-anime",
      field: "status",
      reason: "concurrent_change",
    });

    expect([
      animeConflicts[0]!.localValue,
      animeConflicts[0]!.remoteValue,
    ]).toEqual(expect.arrayContaining(["COMPLETED", "WATCHING"]));

    const allConflicts = await repo.getConflicts();

    expect(allConflicts).toHaveLength(1);
  });

  it("saves a manual status resolution without changing source records", async () => {
    const repo = await createRepository();

    await createStatusConflict(repo, "resolved-anime");

    await repo.resolveStatusConflict("resolved-anime", "COMPLETED");

    expect(await repo.getConflicts("resolved-anime")).toHaveLength(0);

    expect(await repo.getEntry("resolved-anime")).toMatchObject({
      status: "COMPLETED",
      progress: 8,
    });

    const savedResolution = await repo.getConflictResolution("resolved-anime");

    expect(savedResolution).toMatchObject({
      animeId: "resolved-anime",
      status: "COMPLETED",
    });

    const sourceEntries = await repo.getSourceEntries("resolved-anime");

    expect(sourceEntries).toHaveLength(2);

    expect(sourceEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "myanimelist",
          status: "COMPLETED",
        }),
        expect.objectContaining({
          source: "anilist",
          status: "WATCHING",
        }),
      ]),
    );
  });

  it("shows a new conflict when source data changes after resolution", async () => {
    const repo = await createRepository();

    await createStatusConflict(repo, "changed-anime");

    await repo.resolveStatusConflict("changed-anime", "COMPLETED");

    expect(await repo.getConflicts("changed-anime")).toHaveLength(0);

    await repo.saveSourceEntry({
      animeId: "changed-anime",
      source: "myanimelist",
      progress: 9,
      status: "COMPLETED",
      score: null,
      favorite: false,
      updatedAt: "2026-11-16T12:00:00.000Z",
    });

    await repo.saveSourceEntry({
      animeId: "changed-anime",
      source: "anilist",
      progress: 9,
      status: "WATCHING",
      score: null,
      favorite: false,
      updatedAt: "2026-11-17T12:00:00.000Z",
    });

    const conflicts = await repo.getConflicts("changed-anime");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      animeId: "changed-anime",
      field: "status",
      reason: "concurrent_change",
    });
  });
});

describe("BrowserAnimeRepository real-world two-title backup round-trip", () => {
  it("preserves Sankarea provider entries and YummyAnime watch metadata alongside a local-only title", async () => {
    const sourceRepo = await createRepository();
    const targetRepo = await createRepository();
    const exportedAt = "2026-11-22T13:22:41.593Z";

    const sankarea: AnimeIdentity = {
      ...makeAnime("anilist:11499"),
      titles: { english: "Sankarea", synonyms: [] },
      externalIds: { anilist: "11499", myanimelist: "11499" },
      year: 2012,
      format: "TV",
      episodes: 12,
      genres: ["Comedy", "Romance", "Supernatural"],
      averageScore: 7,
      startDate: "2012-04-06",
      releaseStatus: "RELEASED",
    };
    const blackClover: AnimeIdentity = {
      ...makeAnime("anilist:195604"),
      titles: { english: "Black Clover 2nd Season", synonyms: [] },
      externalIds: { anilist: "195604", myanimelist: "61967" },
      year: 2026,
      format: "TV",
      episodes: null,
      genres: ["Action", "Adventure", "Fantasy"],
      averageScore: 8.8,
      startDate: "2026-10-03",
      releaseStatus: "ONGOING",
    };

    await sourceRepo.saveAnime(sankarea);
    await sourceRepo.saveAnime(blackClover);
    await sourceRepo.saveSourceEntries([
      {
        animeId: sankarea.id,
        source: "local",
        status: "PLANNING",
        progress: 0,
        score: null,
        favorite: false,
        updatedAt: "2026-11-20T02:05:37.795Z",
      },
      {
        animeId: sankarea.id,
        source: "yummyanime",
        status: "WATCHING",
        progress: 4,
        score: null,
        favorite: false,
        updatedAt: "2026-11-20T02:05:37.795Z",
        sourceMetadata: {
          lastEpisode: 4,
          lastWatchedUrl: "https://old.yummyani.me/",
          lastWatchedAt: "2026-11-20T02:05:37.795Z",
          lastPositionSeconds: 1331,
          lastDurationSeconds: 1451,
        },
      },
      {
        animeId: blackClover.id,
        source: "local",
        status: "PLANNING",
        progress: 0,
        score: null,
        favorite: false,
        updatedAt: exportedAt,
      },
    ]);

    const exported = await sourceRepo.snapshot();
    exported.exportedAt = exportedAt;

    expect(exported.schemaVersion).toBe(4);
    expect(exported.anime).toHaveLength(2);
    expect(exported.entries).toHaveLength(2);
    expect(exported.sourceEntries).toHaveLength(3);

    await targetRepo.importSnapshot(exported);

    const restored = await targetRepo.snapshot();
    expect(restored.anime).toEqual(exported.anime);
    expect(restored.sourceEntries).toEqual(exported.sourceEntries);
    expect(restored.entries).toEqual(exported.entries);
    expect(await targetRepo.getSourceEntries(sankarea.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "local", status: "PLANNING", progress: 0 }),
        expect.objectContaining({
          source: "yummyanime",
          status: "WATCHING",
          progress: 4,
          sourceMetadata: {
            lastEpisode: 4,
            lastWatchedUrl: "https://old.yummyani.me/",
            lastWatchedAt: "2026-11-20T02:05:37.795Z",
            lastPositionSeconds: 1331,
            lastDurationSeconds: 1451,
          },
        }),
      ]),
    );
    expect(await targetRepo.getEntry(sankarea.id)).toMatchObject({
      source: "yummyanime",
      status: "WATCHING",
      progress: 4,
    });
    expect(await targetRepo.getEntry(blackClover.id)).toMatchObject({
      source: "local",
      status: "PLANNING",
      progress: 0,
    });

    const secondExport = await targetRepo.snapshot();
    await targetRepo.importSnapshot(secondExport);
    expect(await targetRepo.snapshot()).toMatchObject({
      anime: exported.anime,
      entries: exported.entries,
      sourceEntries: exported.sourceEntries,
    });
  });
});

describe("BrowserAnimeRepository V3 backups", () => {
  it("exports manual conflict resolutions in schema version 3", async () => {
    const repo = await createRepository();

    await createStatusConflict(repo, "export-anime");
    await repo.resolveStatusConflict("export-anime", "COMPLETED");

    const snapshot = await repo.snapshot();

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.conflictResolutions).toHaveLength(1);
    expect(snapshot.conflictResolutions[0]).toMatchObject({
      animeId: "export-anime",
      status: "COMPLETED",
    });
  });

  it("restores manual conflict resolutions from a V3 backup", async () => {
    const sourceRepo = await createRepository();

    await createStatusConflict(sourceRepo, "restore-anime");
    await sourceRepo.resolveStatusConflict("restore-anime", "COMPLETED");

    const backup = await sourceRepo.snapshot();

    const targetRepo = await createRepository();
    await targetRepo.importSnapshot(backup);

    expect(await targetRepo.getEntry("restore-anime")).toMatchObject({
      status: "COMPLETED",
      progress: 8,
    });

    expect(await targetRepo.getConflicts("restore-anime")).toHaveLength(0);

    expect(
      await targetRepo.getConflictResolution("restore-anime"),
    ).toMatchObject({
      animeId: "restore-anime",
      status: "COMPLETED",
    });

    expect(await targetRepo.getSourceEntries("restore-anime")).toHaveLength(2);
  });

  it("ignores a V3 conflict resolution when its fingerprint is outdated", async () => {
    const sourceRepo = await createRepository();

    await createStatusConflict(sourceRepo, "stale-anime");
    await sourceRepo.resolveStatusConflict("stale-anime", "COMPLETED");

    const backup = await sourceRepo.snapshot();

    backup.conflictResolutions[0]!.fingerprint = "outdated-fingerprint";

    const targetRepo = await createRepository();
    await targetRepo.importSnapshot(backup);

    expect(
      await targetRepo.getConflictResolution("stale-anime"),
    ).toBeUndefined();

    const conflicts = await targetRepo.getConflicts("stale-anime");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      animeId: "stale-anime",
      field: "status",
    });
  });

  it("cancels unfinished sync operations and sessions when importing a replacement snapshot", async () => {
    const repo = await createRepository();
    const now = "2026-11-17T12:00:00.000Z";

    await repo.saveAnime(makeAnime("old-anime"));
    await repo.saveSourceEntry(makeEntry("old-anime", 4, now));

    const session: SyncSession = {
      sessionId: "import-session",
      provider: "anilist",
      status: "running",
      startedAt: now,
      operationCount: 1,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 1,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    };
    const operation: SyncOperation = {
      id: "pending-import-operation",
      sessionId: session.sessionId,
      provider: "anilist",
      direction: "remote",
      kind: "update",
      animeId: "old-anime",
      entry: { ...makeEntry("old-anime", 4, now), source: "anilist" },
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    await repo.saveSyncSession(session);
    await repo.saveSyncOperations([operation]);

    await repo.importSnapshot(makeSnapshot(["new-anime"], 7));

    expect(await repo.getAnime("old-anime")).toBeUndefined();
    expect(await repo.getAnime("new-anime")).toBeDefined();
    expect(await repo.getUnfinishedSyncOperations()).toEqual([]);
    expect(await repo.getSyncOperations()).toEqual([
      expect.objectContaining({
        id: operation.id,
        animeId: "old-anime",
        status: "cancelled",
      }),
    ]);
    expect(await repo.getSyncSessions()).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        status: "cancelled",
        pendingCount: 0,
      }),
    ]);
  });

  it("keeps the existing library intact when a replacement snapshot is invalid", async () => {
    const repo = await createRepository();
    const existing = makeAnime("existing-before-invalid-restore");
    const existingEntry = makeEntry(existing.id, 6, "2026-11-17T12:00:00.000Z");
    await repo.saveAnimeWithEntry(existing, existingEntry);

    await expect(repo.restoreSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-17T12:00:00.000Z",
      anime: [makeAnime("incoming-anime")],
      entries: [{
        ...makeEntry("missing-anime", 2, "2026-11-17T12:00:00.000Z"),
      }],
      sourceEntries: [],
      conflictResolutions: [],
      animeRelations: [],
    })).rejects.toThrow("Entry references missing anime");

    expect(await repo.getAnime(existing.id)).toEqual(existing);
    expect(await repo.getSourceEntries(existing.id)).toEqual([existingEntry]);
    expect(await repo.getEntry(existing.id)).toMatchObject({ progress: 6 });
    expect(await repo.getAnime("incoming-anime")).toBeUndefined();
  });

  it("restores aggregate-only anime from a mixed snapshot without data loss", async () => {
    const repo = await createRepository();
    const first = makeAnime("provider-backed-anime");
    const second = makeAnime("legacy-only-anime");
    const providerEntry = {
      ...makeEntry(first.id, 4, "2026-11-17T12:00:00.000Z"),
      source: "anilist" as const,
    };
    const legacyEntry = {
      ...makeEntry(second.id, 9, "2026-11-17T12:00:00.000Z"),
      source: "local" as const,
    };

    await repo.restoreSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-17T12:00:00.000Z",
      anime: [first, second],
      entries: [providerEntry, legacyEntry],
      sourceEntries: [providerEntry],
      conflictResolutions: [],
      animeRelations: [],
    });

    expect(await repo.getAnime(first.id)).toEqual(first);
    expect(await repo.getAnime(second.id)).toEqual(second);
    expect(await repo.getSourceEntries(first.id)).toEqual([providerEntry]);
    expect(await repo.getSourceEntries(second.id)).toEqual([legacyEntry]);
    expect(await repo.getEntry(first.id)).toMatchObject({ progress: 4, source: "anilist" });
    expect(await repo.getEntry(second.id)).toMatchObject({ progress: 9, source: "local" });
  });

  it("imports a V2 backup without conflict resolutions", async () => {
    const repo = await createRepository();

    const backup = makeSnapshot(["legacy-anime"], 6);

    await repo.importSnapshot(backup);

    expect(await repo.getAnime("legacy-anime")).toBeDefined();

    expect(await repo.getEntry("legacy-anime")).toMatchObject({
      progress: 6,
      status: "WATCHING",
    });

    expect(await repo.getSourceEntries("legacy-anime")).toHaveLength(1);

    const upgradedBackup = await repo.snapshot();

    expect(upgradedBackup.schemaVersion).toBe(4);
    expect(upgradedBackup.conflictResolutions).toHaveLength(0);
  });

  it("imports a V1 backup and migrates entries into source entries", async () => {
    const repo = await createRepository();

    const entry = makeEntry("v1-anime", 4, "2026-11-15T12:00:00.000Z");

    const backup = {
      schemaVersion: 1,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime: [makeAnime("v1-anime")],
      entries: [entry],
    };

    await repo.importSnapshot(backup);

    expect(await repo.getAnime("v1-anime")).toBeDefined();

    expect(await repo.getEntry("v1-anime")).toMatchObject({
      progress: 4,
      status: "WATCHING",
    });

    expect(await repo.getSourceEntries("v1-anime")).toHaveLength(1);

    const upgradedBackup = await repo.snapshot();

    expect(upgradedBackup.schemaVersion).toBe(4);
    expect(upgradedBackup.sourceEntries).toHaveLength(1);
  });
});

describe("BrowserAnimeRepository mapped import", () => {
  it("maps an imported anime to an existing record and preserves both libraries", async () => {
    const repo = await createRepository();

    const target: AnimeIdentity = {
      id: "target",
      titles: {
        english: "Death Note",
        synonyms: [],
      },
      externalIds: {
        myanimelist: "100",
      },
      episodes: 37,
    };

    const keep = makeAnime("keep");

    await repo.saveAnime(target);
    await repo.saveAnime(keep);

    await repo.saveSourceEntry({
      animeId: "target",
      source: "myanimelist",
      status: "WATCHING",
      progress: 5,
      score: 80,
      favorite: false,
      updatedAt: "2026-11-14T12:00:00.000Z",
    });

    await repo.saveEntry(makeEntry("keep", 3, "2026-11-14T12:00:00.000Z"));

    const imported = makeSnapshot(["imported"], 8);

    imported.anime[0]!.titles.english = "Death Note";
    imported.anime[0]!.externalIds = {
      anilist: "200",
    };

    imported.sourceEntries[0]!.source = "anilist";
    imported.entries[0]!.source = "anilist";

    await repo.mergeSnapshotWithMappings(imported, {
      imported: "target",
    });

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(2);
    expect(snapshot.anime.map((anime) => anime.id)).toContain("target");
    expect(snapshot.anime.map((anime) => anime.id)).not.toContain("imported");

    expect(await repo.getAnime("target")).toMatchObject({
      id: "target",
      externalIds: {
        myanimelist: "100",
        anilist: "200",
      },
    });

    expect(await repo.getEntry("target")).toMatchObject({
      animeId: "target",
      progress: 8,
    });

    expect(await repo.getSourceEntries("target")).toHaveLength(2);

    expect(await repo.getAnime("keep")).toBeDefined();
    expect(await repo.getEntry("keep")).toMatchObject({
      progress: 3,
    });
  });

  it("rejects mappings when the target anime does not exist", async () => {
    const repo = await createRepository();

    const imported = makeSnapshot(["imported"]);

    await expect(
      repo.mergeSnapshotWithMappings(imported, {
        imported: "missing-target",
      }),
    ).rejects.toThrow("Mapping target not found: missing-target");

    expect(await repo.getAnime("imported")).toBeUndefined();
    expect(await repo.getAnime("missing-target")).toBeUndefined();

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(0);
    expect(snapshot.entries).toHaveLength(0);
  });

  it("rejects two imported anime mapped to the same target", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("target"));

    const imported = makeSnapshot(["imported-1", "imported-2"]);

    await expect(
      repo.mergeSnapshotWithMappings(imported, {
        "imported-1": "target",
        "imported-2": "target",
      }),
    ).rejects.toThrow("Duplicate anime mapping detected");

    expect(await repo.getAnime("target")).toBeDefined();
    expect(await repo.getAnime("imported-1")).toBeUndefined();
    expect(await repo.getAnime("imported-2")).toBeUndefined();

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(1);
  });

  it("rejects mappings when external IDs conflict and preserves existing data", async () => {
    const repo = await createRepository();

    const target: AnimeIdentity = {
      id: "target",
      titles: {
        english: "Anime Target",
        synonyms: [],
      },
      externalIds: {
        myanimelist: "100",
      },
    };

    await repo.saveAnime(target);

    await repo.saveSourceEntry({
      animeId: "target",
      source: "myanimelist",
      status: "WATCHING",
      progress: 5,
      score: 80,
      favorite: true,
      updatedAt: "2026-11-14T12:00:00.000Z",
    });

    const imported = makeSnapshot(["imported"], 9);

    imported.anime[0]!.titles.english = "Anime Target";
    imported.anime[0]!.externalIds = {
      myanimelist: "999",
    };

    await expect(
      repo.mergeSnapshotWithMappings(imported, {
        imported: "target",
      }),
    ).rejects.toThrow("External ID conflict for myanimelist");

    expect(await repo.getAnime("target")).toMatchObject({
      externalIds: {
        myanimelist: "100",
      },
    });

    expect(await repo.getAnime("imported")).toBeUndefined();

    expect(await repo.getEntry("target")).toMatchObject({
      progress: 5,
      score: 80,
      favorite: true,
    });

    expect(await repo.getSourceEntries("target")).toHaveLength(1);

    const snapshot = await repo.snapshot();

    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.entries).toHaveLength(1);
  });

  it("rejects chained mappings", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("target"));

    const imported = makeSnapshot(["imported-1", "imported-2"]);

    await expect(
      repo.mergeSnapshotWithMappings(imported, {
        "imported-1": "imported-2",
        "imported-2": "target",
      }),
    ).rejects.toThrow("Chained anime mappings are not allowed");

    expect(await repo.getAnime("target")).toBeDefined();
    expect(await repo.getAnime("imported-1")).toBeUndefined();
    expect(await repo.getAnime("imported-2")).toBeUndefined();
  });
});

describe("BrowserAnimeRepository relations", () => {
  it("saves and retrieves anime relations", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("anime-1"));
    await repo.saveAnime(makeAnime("anime-2"));
    await repo.saveAnime(makeAnime("anime-3"));

    const relation1: AnimeRelation = {
      id: "relation-1",
      sourceAnimeId: "anime-1",
      targetAnimeId: "anime-2",
      type: "SEQUEL",
    };

    const relation2: AnimeRelation = {
      id: "relation-2",
      sourceAnimeId: "anime-3",
      targetAnimeId: "anime-1",
      type: "PREQUEL",
    };

    await repo.saveAnimeRelation(relation1);
    await repo.saveAnimeRelations([relation2]);

    expect(await repo.getAnimeRelations()).toHaveLength(2);

    expect(await repo.getAnimeRelations("anime-1")).toHaveLength(2);
    expect(await repo.getAnimeRelations("anime-2")).toEqual([relation1]);
    expect(await repo.getAnimeRelations("anime-3")).toEqual([relation2]);
  });

  it("restores anime relations from a V4 backup", async () => {
    const sourceRepo = await createRepository();

    await sourceRepo.saveAnime(makeAnime("anime-1"));
    await sourceRepo.saveAnime(makeAnime("anime-2"));

    const relation: AnimeRelation = {
      id: "backup-relation",
      sourceAnimeId: "anime-1",
      targetAnimeId: "anime-2",
      type: "SEQUEL",
      seasonNumber: 2,
    };

    await sourceRepo.saveAnimeRelation(relation);

    const backup = await sourceRepo.snapshot();

    const targetRepo = await createRepository();
    await targetRepo.importSnapshot(backup);

    expect(await targetRepo.getAnimeRelations()).toEqual([relation]);

    const restoredBackup = await targetRepo.snapshot();

    expect(restoredBackup.schemaVersion).toBe(4);
    expect(restoredBackup.animeRelations).toEqual([relation]);
  });

  it("remaps anime relations during mapped import", async () => {
    const sourceRepo = await createRepository();

    await sourceRepo.saveAnime(makeAnime("imported"));
    await sourceRepo.saveAnime(makeAnime("other"));

    await sourceRepo.saveAnimeRelations([
      {
        id: "mapped-relation-1",
        sourceAnimeId: "imported",
        targetAnimeId: "other",
        type: "SEQUEL",
      },
      {
        id: "mapped-relation-2",
        sourceAnimeId: "other",
        targetAnimeId: "imported",
        type: "PREQUEL",
      },
    ]);

    const backup = await sourceRepo.snapshot();

    const targetRepo = await createRepository();
    await targetRepo.saveAnime(makeAnime("target"));

    await targetRepo.mergeSnapshotWithMappings(backup, {
      imported: "target",
    });

    const relations = await targetRepo.getAnimeRelations();

    expect(relations).toHaveLength(2);

    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mapped-relation-1",
          sourceAnimeId: "target",
          targetAnimeId: "other",
        }),
        expect.objectContaining({
          id: "mapped-relation-2",
          sourceAnimeId: "other",
          targetAnimeId: "target",
        }),
      ]),
    );

    expect(await targetRepo.getAnime("imported")).toBeUndefined();
    expect(await targetRepo.getAnime("target")).toBeDefined();
    expect(await targetRepo.getAnime("other")).toBeDefined();
  });

  it("includes anime relations in exported snapshots", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("anime-1"));
    await repo.saveAnime(makeAnime("anime-2"));

    const relation: AnimeRelation = {
      id: "relation-1",
      sourceAnimeId: "anime-1",
      targetAnimeId: "anime-2",
      type: "SEQUEL",
      seasonNumber: 2,
    };

    await repo.saveAnimeRelation(relation);

    const snapshot = await repo.snapshot();

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.animeRelations).toEqual([relation]);
  });

  it("remaps anime relations when merging anime records", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("source"));
    await repo.saveAnime(makeAnime("target"));
    await repo.saveAnime(makeAnime("other"));

    const relations: AnimeRelation[] = [
      {
        id: "relation-1",
        sourceAnimeId: "source",
        targetAnimeId: "other",
        type: "SEQUEL",
      },
      {
        id: "relation-2",
        sourceAnimeId: "other",
        targetAnimeId: "source",
        type: "PREQUEL",
      },
    ];

    await repo.saveAnimeRelations(relations);

    await repo.mergeAnimeRecords("source", "target");

    const savedRelations = await repo.getAnimeRelations();

    expect(savedRelations).toHaveLength(2);

    expect(savedRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "relation-1",
          sourceAnimeId: "target",
          targetAnimeId: "other",
          type: "SEQUEL",
        }),
        expect.objectContaining({
          id: "relation-2",
          sourceAnimeId: "other",
          targetAnimeId: "target",
          type: "PREQUEL",
        }),
      ]),
    );

    expect(savedRelations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceAnimeId: "source",
        }),
      ]),
    );

    expect(savedRelations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetAnimeId: "source",
        }),
      ]),
    );
  });

  it("cancels a Shikimori deletion intent when restoring its anime identity", async () => {
    const repo = await createRepository();
    const anime = makeAnime("shikimori:41");
    anime.externalIds = { shikimori: "41" };
    const entry = {
      ...makeEntry(anime.id, 5, "2026-11-18T10:00:00.000Z"),
      source: "shikimori" as const,
    };
    await repo.saveAnimeWithEntry(anime, entry);
    const intent: SyncDeletionIntent = {
      id: "delete-shikimori-41",
      provider: "shikimori",
      animeId: anime.id,
      externalId: "41",
      anime,
      entry,
      createdAt: "2026-11-18T12:00:00.000Z",
    };
    await repo.deleteAnime(anime.id, [intent]);
    expect(await repo.getDeletionIntents("shikimori")).toHaveLength(1);

    await repo.restoreSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-19T12:00:00.000Z",
      anime: [anime],
      entries: [entry],
      sourceEntries: [entry],
      conflictResolutions: [],
      animeRelations: [],
      deletionIntents: [],
    });

    expect(await repo.getDeletionIntents("shikimori")).toEqual([]);
    expect(await repo.getAnime(anime.id)).toMatchObject({ externalIds: { shikimori: "41" } });
  });

  it("cancels a Shikimori deletion intent when merging an imported snapshot", async () => {
    const repo = await createRepository();
    const anime = makeAnime("shikimori:42");
    anime.externalIds = { shikimori: "42" };
    const entry = {
      ...makeEntry(anime.id, 3, "2026-11-18T10:00:00.000Z"),
      source: "shikimori" as const,
    };
    await repo.saveAnimeWithEntry(anime, entry);
    const intent: SyncDeletionIntent = {
      id: "delete-shikimori-42",
      provider: "shikimori",
      animeId: anime.id,
      externalId: "42",
      anime,
      entry,
      createdAt: "2026-11-18T12:00:00.000Z",
    };
    await repo.deleteAnime(anime.id, [intent]);

    await repo.mergeSnapshotWithMappings({
      schemaVersion: 4,
      exportedAt: "2026-11-19T12:00:00.000Z",
      anime: [anime],
      entries: [entry],
      sourceEntries: [entry],
      conflictResolutions: [],
      animeRelations: [],
      deletionIntents: [],
    }, {});

    expect(await repo.getDeletionIntents("shikimori")).toEqual([]);
    expect(await repo.getAnime(anime.id)).toMatchObject({ externalIds: { shikimori: "42" } });
  });

  it("cancels unfinished sync sessions that reference an anime being deleted", async () => {
    const repo = await createRepository();
    const now = "2026-11-20T12:00:00.000Z";
    const animeIds = ["deleted-anime", "same-session-anime", "unrelated-anime"];

    for (const id of animeIds) {
      await repo.saveAnime(makeAnime(id));
    }

    const createOperation = (id: string, sessionId: string): SyncOperation => ({
      id: `operation-${id}`,
      sessionId,
      provider: "anilist",
      direction: "remote",
      kind: "update",
      animeId: id,
      entry: { ...makeEntry(id, 4, now), source: "anilist" },
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    const createSession = (sessionId: string, operationCount: number): SyncSession => ({
      sessionId,
      provider: "anilist",
      status: "running",
      startedAt: now,
      operationCount,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: operationCount,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    });

    await repo.saveSyncSession(createSession("affected-session", 2));
    await repo.saveSyncSession(createSession("unrelated-session", 1));
    await repo.saveSyncOperations([
      createOperation("deleted-anime", "affected-session"),
      createOperation("same-session-anime", "affected-session"),
      createOperation("unrelated-anime", "unrelated-session"),
    ]);

    await repo.deleteAnime("deleted-anime");

    const operations = await repo.getSyncOperations();
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "operation-deleted-anime",
          animeId: "deleted-anime",
          status: "cancelled",
        }),
        expect.objectContaining({
          id: "operation-same-session-anime",
          animeId: "same-session-anime",
          status: "cancelled",
        }),
        expect.objectContaining({
          id: "operation-unrelated-anime",
          animeId: "unrelated-anime",
          status: "pending",
        }),
      ]),
    );
    expect(await repo.getUnfinishedSyncOperations()).toEqual([
      expect.objectContaining({ id: "operation-unrelated-anime" }),
    ]);
    expect(await repo.getSyncSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "affected-session",
          status: "cancelled",
          pendingCount: 0,
        }),
        expect.objectContaining({
          sessionId: "unrelated-session",
          status: "running",
          pendingCount: 1,
        }),
      ]),
    );
  });

  it("removes anime relations when deleting an anime", async () => {
    const repo = await createRepository();

    await repo.saveAnime(makeAnime("anime-1"));
    await repo.saveAnime(makeAnime("anime-2"));
    await repo.saveAnime(makeAnime("anime-3"));

    await repo.saveAnimeRelations([
      {
        id: "relation-1",
        sourceAnimeId: "anime-1",
        targetAnimeId: "anime-2",
        type: "SEQUEL",
      },
      {
        id: "relation-2",
        sourceAnimeId: "anime-3",
        targetAnimeId: "anime-1",
        type: "PREQUEL",
      },
      {
        id: "relation-3",
        sourceAnimeId: "anime-2",
        targetAnimeId: "anime-3",
        type: "SIDE_STORY",
      },
    ]);

    await repo.deleteAnime("anime-1");

    const savedRelations = await repo.getAnimeRelations();

    expect(savedRelations).toHaveLength(1);
    expect(savedRelations[0]).toMatchObject({
      id: "relation-3",
      sourceAnimeId: "anime-2",
      targetAnimeId: "anime-3",
    });
  });
});

describe("BrowserAnimeRepository catalog metadata", () => {
  it("enriches anime metadata without changing personal watch-list data", async () => {
    const repo = await createRepository();
    const anime = makeAnime("mal:100");
    anime.externalIds = { myanimelist: "100" };
    await repo.saveAnime(anime);
    await repo.saveEntry({
      animeId: "mal:100",
      source: "myanimelist",
      status: "WATCHING",
      progress: 7,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-16T12:00:00.000Z",
    });

    await repo.updateAnimeMetadata("mal:100", {
      id: "anilist:123",
      titles: {
        english: "Example Anime",
        romaji: "Rei Anime",
        native: "例アニメ",
        synonyms: ["Example"],
      },
      externalIds: { anilist: "123", myanimelist: "100" },
      year: 2023,
      format: "TV",
      episodes: 11,
      genres: ["Drama", "Mystery"],
      posterUrl: "https://example.com/poster.jpg",
      averageScore: 8.7,
      startDate: "2023-04-01",
      releaseStatus: "RELEASED",
    });

    expect(await repo.getAnime("mal:100")).toMatchObject({
      id: "mal:100",
      externalIds: { myanimelist: "100", anilist: "123" },
      titles: {
        english: "Example Anime",
        romaji: "Rei Anime",
        native: "例アニメ",
        synonyms: ["Example"],
      },
      year: 2023,
      format: "TV",
      episodes: 11,
      genres: ["Drama", "Mystery"],
      posterUrl: "https://example.com/poster.jpg",
      averageScore: 8.7,
    });

    expect(await repo.getEntry("mal:100")).toMatchObject({
      animeId: "mal:100",
      status: "WATCHING",
      progress: 7,
      score: 90,
      favorite: true,
    });
    expect(await repo.getSourceEntries("mal:100")).toMatchObject([
      {
        source: "myanimelist",
        status: "WATCHING",
        progress: 7,
        score: 90,
        favorite: true,
      },
    ]);
  });

  it("round-trips expanded provider metadata through a V4 backup", async () => {
    const sourceRepo = await createRepository();
    const anime: AnimeIdentity = {
      ...makeAnime("metadata-roundtrip"),
      externalIds: { myanimelist: "100", anilist: "200" },
      synopsis: "Original synopsis",
      background: "Production background",
      bannerUrl: "https://example.com/banner.jpg",
      season: "SPRING",
      seasonYear: 2024,
      durationMinutes: 24,
      episodesAired: 12,
      themes: ["Space"],
      demographics: ["Seinen"],
      tags: [{ name: "Found Family", category: "Theme", rank: 92 }],
      studios: [{ name: "Sunrise", externalId: "14" }],
      producers: [{ name: "Bandai Visual", externalId: "23" }],
      licensors: [{ name: "Example Licensee", externalId: "24" }],
      staff: [{ name: "Director A", externalId: "5", role: "Director", language: "Japanese" }],
      providerScores: {
        myanimelist: {
          meanScore: { value: 8.5, scale: 10, normalizedValue: 85, kind: "mean", voteCount: 1200 },
        },
        anilist: {
          averageScore: { value: 86, scale: 100, normalizedValue: 86, kind: "average" },
        },
      },
      providerMetadata: {
        myanimelist: { rank: 42, rating: "pg_13" },
        anilist: { popularity: 900, favourites: 120 },
      },
    };

    await sourceRepo.saveAnime(anime);
    const backup = await sourceRepo.snapshot();

    const targetRepo = await createRepository();
    await targetRepo.importSnapshot(backup);

    expect(await targetRepo.getAnime(anime.id)).toEqual(anime);
    const restoredBackup = await targetRepo.snapshot();
    expect(restoredBackup.anime[0]).toEqual(anime);
    expect(restoredBackup.schemaVersion).toBe(4);
  });

  it("rejects catalog metadata with a conflicting external ID", async () => {
    const repo = await createRepository();
    const anime = makeAnime("mal:100");
    anime.externalIds = { myanimelist: "100", anilist: "123" };
    await repo.saveAnime(anime);

    await expect(repo.updateAnimeMetadata("mal:100", {
      id: "anilist:999",
      titles: { english: "Wrong match", synonyms: [] },
      externalIds: { myanimelist: "100", anilist: "999" },
    })).rejects.toThrow(/ID conflict for anilist/);

    expect(await repo.getAnime("mal:100")).toMatchObject({
      externalIds: { myanimelist: "100", anilist: "123" },
      titles: { english: "Anime mal:100" },
    });
  });
});


describe("BrowserAnimeRepository sync operation journal", () => {

  it("atomically creates an anime with its first provider entry", async () => {
    const repo = await createRepository();
    const anime = makeAnime("atomic-create");
    const entry = makeEntry("atomic-create", 2, "2026-11-17T12:00:00.000Z");

    await repo.saveAnimeWithEntry(anime, entry);

    expect(await repo.getAnime("atomic-create")).toEqual(anime);
    expect(await repo.getSourceEntries("atomic-create")).toEqual([entry]);
    expect(await repo.getEntry("atomic-create")).toMatchObject({
      animeId: "atomic-create",
      progress: 2,
      source: "myanimelist",
    });
  });

  it("rejects mismatched anime and entry IDs without creating either record", async () => {
    const repo = await createRepository();

    await expect(
      repo.saveAnimeWithEntry(
        makeAnime("anime-one"),
        makeEntry("anime-two", 2, "2026-11-17T12:00:00.000Z"),
      ),
    ).rejects.toThrow("Anime and entry IDs must match");

    expect(await repo.getAnime("anime-one")).toBeUndefined();
    expect(await repo.getEntry("anime-two")).toBeUndefined();
  });
  it("restores the library and preserves completed sync history", async () => {
    const repo = await createRepository();
    const now = "2026-11-17T12:00:00.000Z";
    const completedOperation: SyncOperation = {
      id: "completed-operation",
      sessionId: "completed-session",
      provider: "mal",
      direction: "local",
      kind: "create",
      animeId: "old-anime",
      anime: makeAnime("old-anime"),
      entry: makeEntry("old-anime", 4, now),
      status: "succeeded",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    await repo.saveSyncOperations([completedOperation]);
    await repo.saveAnime(makeAnime("old-anime"));

    await repo.restoreSnapshot(makeSnapshot(["restored-anime"], 7));

    expect(await repo.getAnime("old-anime")).toBeUndefined();
    expect(await repo.getAnime("restored-anime")).toBeDefined();
    expect(await repo.getEntry("restored-anime")).toMatchObject({ progress: 7 });
    expect(await repo.getSyncOperations()).toEqual([completedOperation]);
  });

  it("marks unfinished sync operations and their sessions as interrupted by restore", async () => {
    const repo = await createRepository();
    const now = "2026-11-17T12:00:00.000Z";
    const session: SyncSession = {
      sessionId: "restore-session",
      provider: "anilist",
      status: "running",
      startedAt: now,
      operationCount: 2,
      succeededCount: 1,
      failedCount: 0,
      pendingCount: 1,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    };
    const succeeded: SyncOperation = {
      id: "restore-succeeded",
      sessionId: session.sessionId,
      provider: "anilist",
      direction: "local",
      kind: "update",
      animeId: "old-anime",
      entry: makeEntry("old-anime", 2, now),
      status: "succeeded",
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    const pending: SyncOperation = {
      ...succeeded,
      id: "restore-pending",
      status: "pending",
      attempts: 0,
    };
    await repo.saveSyncSession(session);
    await repo.saveSyncOperations([succeeded, pending]);

    await repo.restoreSnapshot(makeSnapshot(["restored-anime"]));

    expect(await repo.getUnfinishedSyncOperations()).toEqual([]);
    expect(await repo.getSyncOperations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: succeeded.id, status: "succeeded" }),
        expect.objectContaining({
          id: pending.id,
          status: "cancelled",
          error: expect.stringContaining("прервана восстановлением"),
        }),
      ]),
    );
    expect(await repo.getSyncSessions()).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        status: "cancelled",
        pendingCount: 0,
        succeededCount: 1,
        failedCount: 0,
        error: expect.stringContaining("прервана восстановлением"),
      }),
    ]);
  });

  it("clears local library data while preserving and closing sync history", async () => {
    const repo = await createRepository();
    const now = "2026-11-18T12:00:00.000Z";
    await repo.saveAnime(makeAnime("remove-one"));
    await repo.saveAnime(makeAnime("remove-two"));
    await repo.saveEntry(makeEntry("remove-one", 4, now));
    await repo.saveSourceEntry({
      ...makeEntry("remove-one", 4, now),
      source: "anilist",
    });
    await repo.saveAnimeRelation({
      id: "remove-relation",
      sourceAnimeId: "remove-one",
      targetAnimeId: "remove-two",
      type: "SEQUEL",
    });

    const session: SyncSession = {
      sessionId: "clear-session",
      provider: "mal",
      status: "running",
      startedAt: now,
      operationCount: 1,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 1,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    };
    const operation: SyncOperation = {
      id: "clear-pending",
      sessionId: session.sessionId,
      provider: "mal",
      direction: "local",
      kind: "update",
      animeId: "remove-one",
      entry: makeEntry("remove-one", 4, now),
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await repo.saveSyncSession(session);
    await repo.saveSyncOperations([operation]);

    await repo.clearLibrary();

    const snapshot = await repo.snapshot();
    expect(snapshot.anime).toEqual([]);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.sourceEntries).toEqual([]);
    expect(snapshot.conflictResolutions).toEqual([]);
    expect(snapshot.animeRelations).toEqual([]);
    expect(snapshot.deletionIntents).toEqual([]);
    expect(await repo.getUnfinishedSyncOperations()).toEqual([]);
    expect(await repo.getSyncOperations()).toMatchObject([
      {
        id: operation.id,
        status: "cancelled",
        error: expect.stringContaining("полной очисткой"),
      },
    ]);
    expect(await repo.getSyncSessions()).toMatchObject([
      {
        sessionId: session.sessionId,
        status: "cancelled",
        pendingCount: 0,
        error: expect.stringContaining("полной очисткой"),
      },
    ]);
  });

  it("persists operations and tracks independent completion states", async () => {
    const repo = await createRepository();
    const now = "2026-11-17T12:00:00.000Z";
    const operation: SyncOperation = {
      id: "session-1-local-1",
      sessionId: "session-1",
      provider: "mal",
      direction: "local",
      kind: "create",
      animeId: "anime-1",
      anime: makeAnime("anime-1"),
      entry: makeEntry("anime-1", 4, now),
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    await repo.saveSyncOperations([operation]);

    expect(await repo.getUnfinishedSyncOperations("mal")).toEqual([operation]);
    expect(await repo.getUnfinishedSyncOperations("anilist")).toEqual([]);

    await repo.updateSyncOperation(operation.id, {
      status: "in_progress",
      attempts: 1,
    });
    await repo.updateSyncOperation(operation.id, {
      status: "failed",
      error: "Network interrupted",
    });

    expect(await repo.getUnfinishedSyncOperations()).toMatchObject([
      {
        id: operation.id,
        status: "failed",
        attempts: 1,
        error: "Network interrupted",
      },
    ]);

    await repo.updateSyncOperation(operation.id, { status: "succeeded" });

    expect(await repo.getUnfinishedSyncOperations()).toEqual([]);
    expect(await repo.getSyncOperations()).toMatchObject([
      {
        id: operation.id,
        status: "succeeded",
        attempts: 1,
      },
    ]);
  });

  it("rejects updates for unknown journal operations", async () => {
    const repo = await createRepository();
    await expect(
      repo.updateSyncOperation("missing-operation", { status: "succeeded" }),
    ).rejects.toThrow("Unknown sync operation: missing-operation");
  });

  it("persists sessions even when a sync has no operations", async () => {
    const repo = await createRepository();
    const session: SyncSession = {
      sessionId: "no-op-session",
      provider: "anilist",
      status: "running",
      startedAt: "2026-11-17T12:00:00.000Z",
      operationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 0,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    };

    await repo.saveSyncSession(session);
    await repo.updateSyncSession(session.sessionId, {
      status: "succeeded",
      finishedAt: "2026-11-17T12:00:05.000Z",
      unchangedCount: 42,
    });

    expect(await repo.getSyncSessions()).toEqual([{
      ...session,
      status: "succeeded",
      finishedAt: "2026-11-17T12:00:05.000Z",
      unchangedCount: 42,
    }]);
  });

  it("rejects updates for unknown sync sessions", async () => {
    const repo = await createRepository();
    await expect(
      repo.updateSyncSession("missing-session", { status: "failed" }),
    ).rejects.toThrow("Unknown sync session: missing-session");
  });

  it("upgrades a version 1 database through every schema version and preserves legacy entries", async () => {
    const name = `anime-sync-v1-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const anime = makeAnime("legacy-v1-anime");
    const entry = {
      ...makeEntry("legacy-v1-anime", 9, "2026-11-17T12:00:00.000Z"),
      score: 85,
      favorite: true,
      sourceMetadata: { legacyNote: "must survive migration" },
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction(["anime", "entries"], "readwrite");
      transaction.objectStore("anime").put(anime);
      transaction.objectStore("entries").put(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime("legacy-v1-anime")).toEqual(anime);
    expect(await upgraded.getEntry("legacy-v1-anime")).toEqual(entry);
    expect(await upgraded.getSourceEntries("legacy-v1-anime")).toEqual([entry]);
    expect(await upgraded.getSyncOperations()).toEqual([]);
    expect(await upgraded.getSyncSessions()).toEqual([]);
    expect(await upgraded.getDeletionIntents()).toEqual([]);
  });

  it("adds the version 7 deletion-intent store without changing version 6 sync history", async () => {
    const name = `anime-sync-v6-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 6);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
      database.createObjectStore("conflictResolutions", { keyPath: "animeId" });
      database.createObjectStore("animeRelations", { keyPath: "id" });
      const operations = database.createObjectStore("syncOperations", { keyPath: "id" });
      operations.createIndex("by-session", "sessionId");
      operations.createIndex("by-status", "status");
      operations.createIndex("by-provider", "provider");
      const sessions = database.createObjectStore("syncSessions", { keyPath: "sessionId" });
      sessions.createIndex("by-started-at", "startedAt");
      sessions.createIndex("by-provider", "provider");
      sessions.createIndex("by-status", "status");
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const session: SyncSession = {
      sessionId: "v6-session",
      provider: "anilist",
      status: "succeeded",
      startedAt: "2026-11-17T12:00:00.000Z",
      finishedAt: "2026-11-17T12:00:05.000Z",
      operationCount: 1,
      succeededCount: 1,
      failedCount: 0,
      pendingCount: 0,
      unchangedCount: 0,
      conflictCount: 0,
      recoveredCount: 0,
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction("syncSessions", "readwrite");
      transaction.objectStore("syncSessions").put(session);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getSyncSessions()).toEqual([session]);
    expect(await upgraded.getDeletionIntents()).toEqual([]);
  });

  it("upgrades a version 5 journal and keeps unfinished operations readable", async () => {
    const name = `anime-sync-v5-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
      database.createObjectStore("conflictResolutions", { keyPath: "animeId" });
      database.createObjectStore("animeRelations", { keyPath: "id" });
      const operations = database.createObjectStore("syncOperations", { keyPath: "id" });
      operations.createIndex("by-session", "sessionId");
      operations.createIndex("by-status", "status");
      operations.createIndex("by-provider", "provider");
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const operation: SyncOperation = {
      id: "legacy-session-local-0",
      sessionId: "legacy-session",
      provider: "mal",
      direction: "local",
      kind: "create",
      animeId: "legacy-anime",
      entry: makeEntry("legacy-anime", 2, "2026-11-17T12:00:00.000Z"),
      status: "in_progress",
      attempts: 1,
      createdAt: "2026-11-17T12:00:00.000Z",
      updatedAt: "2026-11-17T12:00:01.000Z",
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction("syncOperations", "readwrite");
      transaction.objectStore("syncOperations").put(operation);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getUnfinishedSyncOperations("mal")).toEqual([operation]);
    expect(await upgraded.getSyncSessions()).toEqual([]);
  });

  it("upgrades an existing version 4 database without losing its anime records", async () => {
    const name = `anime-sync-v4-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
      database.createObjectStore("conflictResolutions", { keyPath: "animeId" });
      database.createObjectStore("animeRelations", { keyPath: "id" });
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction("anime", "readwrite");
      transaction.objectStore("anime").put(makeAnime("preserved-anime"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime("preserved-anime")).toMatchObject({
      id: "preserved-anime",
    });
    expect(await upgraded.getUnfinishedSyncOperations()).toEqual([]);
  });
});


describe("BrowserAnimeRepository identity reconciliation", () => {
  it("stores a cross-provider import on the existing canonical anime and keeps both source entries", async () => {
    const repo = await createRepository();
    const existing = makeAnime("mal:100");
    existing.titles.english = "Example Anime";
    existing.externalIds = { myanimelist: "100" };
    await repo.saveAnime(existing);
    await repo.saveSourceEntry({
      ...makeEntry("mal:100", 10, "2026-11-18T10:00:00.000Z"),
      source: "myanimelist",
      score: 80,
      sourceMetadata: { comments: "MAL note" },
    });

    const imported = makeAnime("anilist:200");
    imported.titles.english = "Example Anime";
    imported.externalIds = { myanimelist: "100", anilist: "200" };
    await repo.saveAnimeWithEntry(imported, {
      ...makeEntry("anilist:200", 8, "2026-11-18T11:00:00.000Z"),
      source: "anilist",
      score: 90,
      favorite: true,
      sourceMetadata: { repeat: 1 },
    });

    const snapshot = await repo.snapshot();
    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.anime[0]).toMatchObject({
      id: "mal:100",
      externalIds: { myanimelist: "100", anilist: "200" },
    });
    expect(snapshot.sourceEntries).toHaveLength(2);
    expect(snapshot.sourceEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ animeId: "mal:100", source: "myanimelist", progress: 10, score: 80, sourceMetadata: { comments: "MAL note" } }),
      expect.objectContaining({ animeId: "mal:100", source: "anilist", progress: 8, score: 90, favorite: true, sourceMetadata: { repeat: 1 } }),
    ]));
    expect(snapshot.entries[0]).toMatchObject({ animeId: "mal:100", progress: 10, favorite: true });
  });

  it("removes only the Shikimori source entry and preserves other providers", async () => {
    const repo = await createRepository();
    const anime = makeAnime("shikimori:41");
    anime.externalIds = { shikimori: "41" };
    await repo.saveAnime(anime);
    await repo.saveSourceEntry({
      ...makeEntry(anime.id, 5, "2026-11-18T10:00:00.000Z"),
      source: "shikimori",
      sourceMetadata: { shikimoriRateId: 901 },
    });
    await repo.saveSourceEntry({
      ...makeEntry(anime.id, 3, "2026-11-18T11:00:00.000Z"),
      source: "anilist",
      sourceMetadata: { anilistEntryId: 902 },
    });

    await repo.deleteSourceEntry(anime.id, "shikimori");

    const snapshot = await repo.snapshot();
    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.sourceEntries[0]).toMatchObject({
      animeId: anime.id,
      source: "anilist",
      sourceMetadata: { anilistEntryId: 902 },
    });
    expect(snapshot.entries[0]).toMatchObject({ animeId: anime.id, progress: 3 });
  });

  it("repairs an existing exact-ID duplicate pair without dropping provider baselines", async () => {
    const repo = await createRepository();
    const mal = makeAnime("mal:100");
    mal.externalIds = { myanimelist: "100" };
    const anilist = makeAnime("anilist:200");
    anilist.externalIds = { myanimelist: "100", anilist: "200" };
    await repo.saveAnime(mal);
    await repo.saveAnime(anilist);
    await repo.saveSourceEntry({
      ...makeEntry("mal:100", 10, "2026-11-18T10:00:00.000Z"),
      source: "myanimelist",
      sourceMetadata: { comments: "preserve me" },
    });
    await repo.saveSourceEntry({
      ...makeEntry("anilist:200", 8, "2026-11-18T11:00:00.000Z"),
      source: "anilist",
      sourceMetadata: { repeat: 2 },
    });

    const result = await repo.reconcileExactIdentityDuplicates();
    const snapshot = await repo.snapshot();

    expect(result).toEqual({ mergedPairs: 1, skippedPairs: 0 });
    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.anime[0]?.externalIds).toEqual({ myanimelist: "100", anilist: "200" });
    expect(snapshot.sourceEntries).toHaveLength(2);
    expect(snapshot.sourceEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "myanimelist", sourceMetadata: { comments: "preserve me" } }),
      expect.objectContaining({ source: "anilist", sourceMetadata: { repeat: 2 } }),
    ]));
  });

  it("remaps sync journal and pending deletion references when anime identities are merged", async () => {
    const repo = await createRepository();
    const mal = makeAnime("mal:100");
    mal.externalIds = { myanimelist: "100" };
    const anilist = makeAnime("anilist:200");
    anilist.externalIds = { myanimelist: "100", anilist: "200" };
    const malEntry: AnimeListEntry = {
      ...makeEntry("mal:100", 6, "2026-11-18T10:00:00.000Z"),
      source: "myanimelist",
    };
    const aniEntry: AnimeListEntry = {
      ...makeEntry("anilist:200", 8, "2026-11-18T11:00:00.000Z"),
      source: "anilist",
    };
    const deletionIntent: SyncDeletionIntent = {
      id: "delete-mal-100",
      provider: "mal",
      animeId: "mal:100",
      externalId: "100",
      anime: mal,
      entry: malEntry,
      createdAt: "2026-11-18T12:00:00.000Z",
    };

    await repo.saveAnime(mal);
    await repo.saveAnime(anilist);
    await repo.saveSourceEntry(malEntry);
    await repo.saveSourceEntry(aniEntry);

    // Seed a pending intent directly: saving a source entry intentionally
    // cancels a matching pending remote deletion.
    const internal = repo as unknown as {
      db: { put: (store: string, value: SyncDeletionIntent) => Promise<unknown> };
    };
    await internal.db.put("deletionIntents", deletionIntent);

    const operation: SyncOperation = {
      id: "operation-1",
      sessionId: "session-1",
      provider: "mal",
      direction: "remote",
      kind: "update",
      animeId: "mal:100",
      externalId: "100",
      entry: malEntry,
      anime: mal,
      status: "pending",
      attempts: 0,
      createdAt: "2026-11-18T12:00:00.000Z",
      updatedAt: "2026-11-18T12:00:00.000Z",
    };
    await repo.saveSyncOperations([operation]);

    await repo.mergeAnimeRecords("mal:100", "anilist:200");

    const operations = await repo.getSyncOperations();
    const deletionIntents = await repo.getDeletionIntents();
    const snapshot = await repo.snapshot();

    expect(operations[0]).toMatchObject({
      animeId: "anilist:200",
      entry: { animeId: "anilist:200" },
      anime: { id: "anilist:200" },
    });
    expect(deletionIntents[0]).toMatchObject({
      animeId: "anilist:200",
      externalId: "100",
      entry: { animeId: "anilist:200" },
      anime: { id: "anilist:200" },
    });
    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.sourceEntries).toHaveLength(2);
  });

  it("skips duplicate groups that contain multiple records for the same provider", async () => {
    const repo = await createRepository();
    const first = makeAnime("first");
    first.externalIds = { myanimelist: "100" };
    const second = makeAnime("second");
    second.externalIds = { myanimelist: "100", anilist: "200" };
    await repo.saveAnime(first);
    await repo.saveAnime(second);
    await repo.saveSourceEntry(makeEntry("first", 5, "2026-11-18T10:00:00.000Z"));
    await repo.saveSourceEntry(makeEntry("second", 7, "2026-11-18T11:00:00.000Z"));

    const result = await repo.reconcileExactIdentityDuplicates();

    expect(result).toEqual({ mergedPairs: 0, skippedPairs: 1 });
    expect((await repo.snapshot()).anime).toHaveLength(2);
  });
});


describe("BrowserAnimeRepository migration regression", () => {
  async function createVersion8Database(
    name: string,
    includeMetadata: boolean,
    includeImportHistory: boolean,
  ): Promise<IDBDatabase> {
    const request = indexedDB.open(name, 8);

    request.onupgradeneeded = () => {
      const database = request.result;

      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", {
        keyPath: ["animeId", "source"],
      });
      database.createObjectStore("conflictResolutions", {
        keyPath: "animeId",
      });
      database.createObjectStore("animeRelations", { keyPath: "id" });

      const operations = database.createObjectStore("syncOperations", {
        keyPath: "id",
      });
      operations.createIndex("by-session", "sessionId");
      operations.createIndex("by-status", "status");
      operations.createIndex("by-provider", "provider");

      const sessions = database.createObjectStore("syncSessions", {
        keyPath: "sessionId",
      });
      sessions.createIndex("by-started-at", "startedAt");
      sessions.createIndex("by-provider", "provider");
      sessions.createIndex("by-status", "status");

      const deletions = database.createObjectStore("deletionIntents", {
        keyPath: "id",
      });
      deletions.createIndex("by-provider", "provider");
      deletions.createIndex("by-created-at", "createdAt");

      if (includeMetadata) {
        database.createObjectStore("appMetadata", { keyPath: "key" });
      }

      if (includeImportHistory) {
        const imports = database.createObjectStore("importHistory", {
          keyPath: "id",
        });
        imports.createIndex("by-started-at", "startedAt");
        imports.createIndex("by-provider", "provider");
      }
    };

    return new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it("repairs a version 8 database containing appMetadata but no importHistory", async () => {
    const name = `anime-sync-v8-metadata-${Date.now()}-${Math.random()}`;
    const oldDatabase = await createVersion8Database(name, true, false);
    const anime = makeAnime("legacy-v8-metadata");

    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction(
        ["anime", "appMetadata"],
        "readwrite",
      );
      transaction.objectStore("anime").put(anime);
      transaction.objectStore("appMetadata").put({
        key: "legacy-marker",
        value: "preserve-me",
        updatedAt: "2026-11-20T12:00:00.000Z",
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime(anime.id)).toEqual(anime);

    const checkRequest = indexedDB.open(name);
    const checkDatabase = await requestValue(checkRequest);

    expect(checkDatabase.version).toBe(9);
    expect(checkDatabase.objectStoreNames.contains("appMetadata")).toBe(true);
    expect(checkDatabase.objectStoreNames.contains("importHistory")).toBe(true);

    const transaction = checkDatabase.transaction(
      ["appMetadata", "importHistory"],
      "readonly",
    );
    const metadata = await requestValue(
      transaction.objectStore("appMetadata").get("legacy-marker"),
    );
    const schemaVersion = await requestValue(
      transaction.objectStore("appMetadata").get("schemaVersion"),
    );

    expect(metadata).toMatchObject({
      key: "legacy-marker",
      value: "preserve-me",
    });
    expect(schemaVersion).toMatchObject({
      key: "schemaVersion",
      value: 9,
    });

    expect(
      transaction.objectStore("importHistory").indexNames.contains("by-started-at"),
    ).toBe(true);
    expect(
      transaction.objectStore("importHistory").indexNames.contains("by-provider"),
    ).toBe(true);

    checkDatabase.close();
  });

  it("repairs a version 8 database containing importHistory but no appMetadata", async () => {
    const name = `anime-sync-v8-imports-${Date.now()}-${Math.random()}`;
    const oldDatabase = await createVersion8Database(name, false, true);
    const anime = makeAnime("legacy-v8-imports");
    const importEvent = {
      id: "legacy-import-event",
      provider: "animego" as const,
      kind: "account_list_import" as const,
      status: "succeeded" as const,
      importedCount: 12,
      skippedCount: 3,
      startedAt: "2026-11-20T12:00:00.000Z",
      finishedAt: "2026-11-20T12:00:05.000Z",
    };

    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction(
        ["anime", "importHistory"],
        "readwrite",
      );
      transaction.objectStore("anime").put(anime);
      transaction.objectStore("importHistory").put(importEvent);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime(anime.id)).toEqual(anime);

    const checkRequest = indexedDB.open(name);
    const checkDatabase = await requestValue(checkRequest);

    expect(checkDatabase.version).toBe(9);
    expect(checkDatabase.objectStoreNames.contains("appMetadata")).toBe(true);
    expect(checkDatabase.objectStoreNames.contains("importHistory")).toBe(true);

    const transaction = checkDatabase.transaction(
      ["appMetadata", "importHistory"],
      "readonly",
    );
    const preservedEvent = await requestValue(
      transaction.objectStore("importHistory").get(importEvent.id),
    );
    const schemaVersion = await requestValue(
      transaction.objectStore("appMetadata").get("schemaVersion"),
    );

    expect(preservedEvent).toEqual(importEvent);
    expect(schemaVersion).toMatchObject({
      key: "schemaVersion",
      value: 9,
    });

    expect(
      transaction.objectStore("importHistory").indexNames.contains("by-started-at"),
    ).toBe(true);
    expect(
      transaction.objectStore("importHistory").indexNames.contains("by-provider"),
    ).toBe(true);

    checkDatabase.close();
  });
  it("upgrades a version 2 database while preserving its provider baseline", async () => {
    const name = `anime-sync-v2-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const anime = makeAnime("legacy-v2-anime");
    const entry = {
      ...makeEntry("legacy-v2-anime", 6, "2026-11-17T12:00:00.000Z"),
      source: "anilist" as const,
      score: 88,
      favorite: true,
      sourceMetadata: { anilistEntryId: 2201 },
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction(
        ["anime", "entries", "sourceEntries"],
        "readwrite",
      );
      transaction.objectStore("anime").put(anime);
      transaction.objectStore("entries").put(entry);
      transaction.objectStore("sourceEntries").put(entry);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime(anime.id)).toEqual(anime);
    expect(await upgraded.getEntry(anime.id)).toEqual(entry);
    expect(await upgraded.getSourceEntries(anime.id)).toEqual([entry]);
    expect(await upgraded.getSyncOperations()).toEqual([]);
    expect(await upgraded.getSyncSessions()).toEqual([]);
    expect(await upgraded.getDeletionIntents()).toEqual([]);
  });

  it("upgrades a version 3 database while preserving conflict decisions", async () => {
    const name = `anime-sync-v3-upgrade-${Date.now()}-${Math.random()}`;
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("anime", { keyPath: "id" });
      database.createObjectStore("entries", { keyPath: "animeId" });
      database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
      database.createObjectStore("conflictResolutions", { keyPath: "animeId" });
    };
    const oldDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const anime = makeAnime("legacy-v3-anime");
    const entry = makeEntry(anime.id, 7, "2026-11-17T12:00:00.000Z");
    const resolution = {
      animeId: anime.id,
      status: "WATCHING" as const,
      fingerprint: "legacy-v3-fingerprint",
      resolvedAt: "2026-11-17T12:01:00.000Z",
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = oldDatabase.transaction(
        ["anime", "entries", "sourceEntries", "conflictResolutions"],
        "readwrite",
      );
      transaction.objectStore("anime").put(anime);
      transaction.objectStore("entries").put(entry);
      transaction.objectStore("sourceEntries").put(entry);
      transaction.objectStore("conflictResolutions").put(resolution);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    oldDatabase.close();

    const upgraded = await BrowserAnimeRepository.open(name);
    repositories.push(upgraded);

    expect(await upgraded.getAnime(anime.id)).toEqual(anime);
    expect(await upgraded.getSourceEntries(anime.id)).toEqual([entry]);
    expect(await upgraded.getConflictResolution(anime.id)).toEqual(resolution);
    expect(await upgraded.getAnimeRelations()).toEqual([]);
    expect(await upgraded.getSyncOperations()).toEqual([]);
    expect(await upgraded.getSyncSessions()).toEqual([]);
    expect(await upgraded.getDeletionIntents()).toEqual([]);
  });
});

describe("BrowserAnimeRepository duplicate merge idempotency", () => {
  it("does not change the library when exact-identity reconciliation is repeated", async () => {
    const repo = await createRepository();
    const mal = makeAnime("mal:700");
    mal.externalIds = { myanimelist: "700" };
    const anilist = makeAnime("anilist:900");
    anilist.externalIds = { myanimelist: "700", anilist: "900" };
    await repo.saveAnime(mal);
    await repo.saveAnime(anilist);
    await repo.saveSourceEntry({
      ...makeEntry(mal.id, 12, "2026-11-18T10:00:00.000Z"),
      source: "myanimelist",
      score: 91,
      favorite: true,
      sourceMetadata: { comments: "kept" },
    });
    await repo.saveSourceEntry({
      ...makeEntry(anilist.id, 8, "2026-11-18T11:00:00.000Z"),
      source: "anilist",
      score: 87,
      sourceMetadata: { repeat: 3 },
    });

    expect(await repo.reconcileExactIdentityDuplicates()).toEqual({
      mergedPairs: 1,
      skippedPairs: 0,
    });
    const firstSnapshot = await repo.snapshot();

    expect(await repo.reconcileExactIdentityDuplicates()).toEqual({
      mergedPairs: 0,
      skippedPairs: 0,
    });
    const secondSnapshot = await repo.snapshot();

    expect(secondSnapshot.anime).toEqual(firstSnapshot.anime);
    expect(secondSnapshot.entries).toEqual(firstSnapshot.entries);
    expect(secondSnapshot.sourceEntries).toEqual(firstSnapshot.sourceEntries);
    expect(secondSnapshot.conflictResolutions).toEqual(firstSnapshot.conflictResolutions);
    expect(secondSnapshot.animeRelations).toEqual(firstSnapshot.animeRelations);
    expect(secondSnapshot.deletionIntents).toEqual(firstSnapshot.deletionIntents);
  });
});


describe("BrowserAnimeRepository duplicate conflict safety", () => {
  it("keeps records separate when one shared provider ID hides a conflicting external ID", async () => {
    const repo = await createRepository();
    const first = makeAnime("first-record");
    first.externalIds = { myanimelist: "100", anilist: "200" };
    const second = makeAnime("second-record");
    second.externalIds = { myanimelist: "100", anilist: "999" };
    await repo.saveAnime(first);
    await repo.saveAnime(second);
    const firstEntry = {
      ...makeEntry(first.id, 5, "2026-11-18T10:00:00.000Z"),
      source: "myanimelist" as const,
    };
    const secondEntry = {
      ...makeEntry(second.id, 7, "2026-11-18T11:00:00.000Z"),
      source: "anilist" as const,
    };
    await repo.saveSourceEntry(firstEntry);
    await repo.saveSourceEntry(secondEntry);

    const result = await repo.reconcileExactIdentityDuplicates();

    expect(result).toEqual({ mergedPairs: 0, skippedPairs: 1 });
    expect(await repo.getAnime(first.id)).toEqual(first);
    expect(await repo.getAnime(second.id)).toEqual(second);
    expect(await repo.getSourceEntries(first.id)).toEqual([firstEntry]);
    expect(await repo.getSourceEntries(second.id)).toEqual([secondEntry]);
  });
});

describe("three-tracker import order integration", () => {
  const providers = {
    mal: {
      id: "mal:1001",
      source: "myanimelist" as const,
      externalIds: { myanimelist: "1001" },
      progress: 4,
      status: "WATCHING" as const,
      score: 90,
      favorite: false,
      sourceMetadata: { tags: ["mal-tag"], comments: "MAL note", timesRewatched: 0 },
    },
    anilist: {
      id: "anilist:2001",
      source: "anilist" as const,
      externalIds: { myanimelist: "1001", anilist: "2001" },
      progress: 7,
      status: "REWATCHING" as const,
      score: 85,
      favorite: true,
      sourceMetadata: { notes: "AniList note", repeat: 2 },
    },
    shikimori: {
      id: "shikimori:3001",
      source: "shikimori" as const,
      externalIds: { myanimelist: "1001", shikimori: "3001" },
      progress: 12,
      status: "COMPLETED" as const,
      score: 80,
      favorite: false,
      sourceMetadata: { shikimoriRateId: 9001, rewatches: 3, text: "Shikimori note" },
    },
  };

  const orders = [
    ["mal", "anilist", "shikimori"],
    ["mal", "shikimori", "anilist"],
    ["anilist", "shikimori", "mal"],
    ["anilist", "mal", "shikimori"],
    ["shikimori", "anilist", "mal"],
    ["shikimori", "mal", "anilist"],
  ] as const;

  it.each(orders.map((order) => ({ order })))("converges to one anime with all three provider records for order $order", async ({ order }) => {
    const repo = await createRepository();

    for (const provider of order) {
      const config = providers[provider];
      const snapshot = makeSnapshot([config.id], config.progress);
      snapshot.anime[0]!.externalIds = { ...config.externalIds };
      snapshot.entries[0]!.source = config.source;
      snapshot.entries[0]!.status = config.status;
      snapshot.entries[0]!.score = config.score;
      snapshot.entries[0]!.favorite = config.favorite;
      snapshot.entries[0]!.sourceMetadata = structuredClone(config.sourceMetadata);
      snapshot.sourceEntries[0]!.source = config.source;
      snapshot.sourceEntries[0]!.status = config.status;
      snapshot.sourceEntries[0]!.score = config.score;
      snapshot.sourceEntries[0]!.favorite = config.favorite;
      snapshot.sourceEntries[0]!.sourceMetadata = structuredClone(config.sourceMetadata);

      const current = await repo.snapshot();
      const preview = createImportPreview(snapshot.anime, current.anime);
      expect(preview.summary).toEqual({
        total: 1,
        new: current.anime.length === 0 ? 1 : 0,
        matched: current.anime.length === 0 ? 0 : 1,
      });

      const match = preview.items[0]!.matchedAnime;
      const mappings = match ? { [config.id]: match.id } : {};
      await repo.mergeSnapshotWithMappings(snapshot, mappings);
    }

    const result = await repo.snapshot();
    expect(result.anime).toHaveLength(1);
    expect(result.anime[0]!.externalIds).toEqual({
      myanimelist: "1001",
      anilist: "2001",
      shikimori: "3001",
    });
    expect(result.sourceEntries).toHaveLength(3);
    expect(result.sourceEntries.map((entry) => entry.source).sort()).toEqual([
      "anilist",
      "myanimelist",
      "shikimori",
    ]);
    expect(result.sourceEntries.find((entry) => entry.source === "myanimelist")?.sourceMetadata)
      .toEqual(providers.mal.sourceMetadata);
    expect(result.sourceEntries.find((entry) => entry.source === "anilist")?.sourceMetadata)
      .toEqual(providers.anilist.sourceMetadata);
    expect(result.sourceEntries.find((entry) => entry.source === "shikimori")?.sourceMetadata)
      .toEqual(providers.shikimori.sourceMetadata);
    expect(result.sourceEntries.find((entry) => entry.source === "myanimelist"))
      .toMatchObject({ status: "WATCHING", progress: 4, score: 90, favorite: false });
    expect(result.sourceEntries.find((entry) => entry.source === "anilist"))
      .toMatchObject({ status: "REWATCHING", progress: 7, score: 85, favorite: true });
    expect(result.sourceEntries.find((entry) => entry.source === "shikimori"))
      .toMatchObject({ status: "COMPLETED", progress: 12, score: 80, favorite: false });
  });
});
