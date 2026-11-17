import { describe, expect, it } from "vitest";
import { createRestorePreview } from "../src/core/restore-preview.js";
import type { AnimeIdentity, AnimeSnapshotV4 } from "../src/core/types.js";

function makeAnime(id: string, externalIds: AnimeIdentity["externalIds"] = {}): AnimeIdentity {
  return {
    id,
    titles: { english: `Anime ${id}`, synonyms: [] },
    externalIds,
    episodes: 12,
  };
}

function makeSnapshot(anime: AnimeIdentity[]): AnimeSnapshotV4 {
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-15T12:00:00.000Z",
    anime,
    entries: [],
    sourceEntries: [],
    conflictResolutions: [],
    animeRelations: [],
  };
}

describe("restore preview", () => {
  it("classifies added, updated, unchanged, and removed anime records", () => {
    const current = makeSnapshot([
      makeAnime("same", { myanimelist: "1" }),
      makeAnime("update", { myanimelist: "2" }),
      makeAnime("remove"),
    ]);
    const backup = makeSnapshot([
      makeAnime("same", { myanimelist: "1" }),
      makeAnime("update", { myanimelist: "22" }),
      makeAnime("add"),
    ]);

    const preview = createRestorePreview(backup, current);

    expect(preview.collections.anime).toEqual({
      added: 1,
      updated: 1,
      unchanged: 1,
      removed: 1,
    });
  });

  it("compares all backup collections", () => {
    const current = makeSnapshot([makeAnime("one")]);
    const backup = makeSnapshot([makeAnime("one")]);
    current.sourceEntries.push({
      animeId: "one",
      status: "WATCHING",
      progress: 1,
      score: null,
      favorite: false,
      updatedAt: "2026-11-15T12:00:00.000Z",
      source: "local",
    });

    const preview = createRestorePreview(backup, current);

    expect(preview.collections.sourceEntries.removed).toBe(1);
  });

  it("reports an external ID change on the same anime record", () => {
    const current = makeSnapshot([makeAnime("one", { myanimelist: "1" })]);
    const backup = makeSnapshot([makeAnime("one", { myanimelist: "2" })]);

    const preview = createRestorePreview(backup, current);

    expect(preview.conflicts).toEqual([
      {
        animeId: "one",
        service: "myanimelist",
        currentExternalId: "1",
        backupExternalId: "2",
        reason: "changed",
      },
    ]);
    expect(preview.summary.conflicts).toBe(1);
  });

  it("reports when a backup external ID belongs to another current anime", () => {
    const current = makeSnapshot([makeAnime("old-owner", { anilist: "42" })]);
    const backup = makeSnapshot([makeAnime("new-owner", { anilist: "42" })]);

    const preview = createRestorePreview(backup, current);

    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]).toMatchObject({
      animeId: "new-owner",
      service: "anilist",
      reason: "reassigned",
    });
  });

  it("does not mutate either snapshot", () => {
    const current = makeSnapshot([makeAnime("current")]);
    const backup = makeSnapshot([makeAnime("backup")]);
    const currentBefore = structuredClone(current);
    const backupBefore = structuredClone(backup);

    createRestorePreview(backup, current);

    expect(current).toEqual(currentBefore);
    expect(backup).toEqual(backupBefore);
  });

  it("treats object key order as irrelevant", () => {
    const current = makeSnapshot([{
      id: "one",
      titles: { english: "One", synonyms: [] },
      externalIds: { myanimelist: "1", anilist: "2" },
    }]);
    const backup = makeSnapshot([{
      id: "one",
      titles: { synonyms: [], english: "One" },
      externalIds: { anilist: "2", myanimelist: "1" },
    }]);

    const preview = createRestorePreview(backup, current);

    expect(preview.collections.anime.unchanged).toBe(1);
  });
});
