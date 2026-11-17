import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { BrowserAnimeRepository } from "../src/storage/browser-repository.js";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeRelation,
  AnimeSnapshot,
  SyncOperation,
  SyncSession,
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

  it("keeps the newer entry when both records use the same service", async () => {
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

    await repo.mergeAnimeRecords("source", "target");

    const sources = await repo.getSourceEntries("target");

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      animeId: "target",
      source: "myanimelist",
      progress: 9,
      score: 95,
      favorite: true,
      updatedAt: "2026-11-15T12:00:00.000Z",
    });

    expect(await repo.getEntry("target")).toMatchObject({
      progress: 9,
      score: 95,
      favorite: true,
    });
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
    expect(await repo.getSyncOperations()).toEqual([
      expect.objectContaining({ id: succeeded.id, status: "succeeded" }),
      expect.objectContaining({
        id: pending.id,
        status: "failed",
        error: expect.stringContaining("прервана восстановлением"),
      }),
    ]);
    expect(await repo.getSyncSessions()).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        status: "failed",
        pendingCount: 0,
        succeededCount: 1,
        failedCount: 1,
        error: expect.stringContaining("прервана восстановлением"),
      }),
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
