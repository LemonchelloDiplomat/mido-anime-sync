import { describe, expect, it } from "vitest";
import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "../src/core/types.js";
import { reconcileStreamingAccountSnapshot } from "../src/services/streaming-account-import.js";

function identity(id: string, externalIds: AnimeIdentity["externalIds"] = {}): AnimeIdentity {
  return {
    id,
    titles: { romaji: "Same Anime", synonyms: [] },
    externalIds,
    year: 2024,
    episodes: 12,
    genres: [],
    posterUrl: null,
    averageScore: null,
  };
}

function snapshot(anime: AnimeIdentity): AnimeSnapshotV4 {
  const entry: AnimeListEntry = {
    animeId: anime.id,
    status: "WATCHING",
    progress: 4,
    score: null,
    favorite: false,
    updatedAt: "2026-11-20T00:00:00.000Z",
    source: "yummyanime",
  };
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-20T00:00:00.000Z",
    anime: [anime],
    entries: [entry],
    sourceEntries: [entry],
    conflictResolutions: [],
    animeRelations: [],
  };
}

describe("streaming account import reconciliation", () => {
  it("maps a YummyAnime record to an existing title only through an exact MAL ID", () => {
    const incoming = identity("yummyanime:456", { yummyanime: "456", myanimelist: "123" });
    const local = identity("local:1", { myanimelist: "123" });
    const result = reconcileStreamingAccountSnapshot(snapshot(incoming), [local]);

    expect(result.anime).toHaveLength(1);
    expect(result.anime[0]?.id).toBe("local:1");
    expect(result.anime[0]?.externalIds).toMatchObject({ myanimelist: "123", yummyanime: "456" });
    expect(result.entries[0]?.animeId).toBe("local:1");
    expect(result.sourceEntries[0]?.animeId).toBe("local:1");
  });

  it("reconciles AnimeGO and AnixART snapshots through exact provider IDs", () => {
    for (const [service, externalId] of [["animego", "naruto-123"], ["anixart", "7360"]] as const) {
      const incoming = identity(service + ":" + externalId, { [service]: externalId });
      const local = identity("local:" + service, { [service]: externalId });
      const result = reconcileStreamingAccountSnapshot(snapshot(incoming), [local]);
      expect(result.anime).toHaveLength(1);
      expect(result.anime[0]?.id).toBe(local.id);
      expect(result.entries[0]?.animeId).toBe(local.id);
    }
  });

  it("does not merge matching titles when there is no shared external ID", () => {
    const incoming = identity("yummyanime:456", { yummyanime: "456" });
    const local = identity("local:1");
    const result = reconcileStreamingAccountSnapshot(snapshot(incoming), [local]);

    expect(result.anime.map((anime) => anime.id)).toEqual(["yummyanime:456"]);
    expect(result.entries[0]?.animeId).toBe("yummyanime:456");
  });

  it("leaves ambiguous exact-ID matches separate instead of choosing one duplicate", () => {
    const incoming = identity("yummyanime:456", { yummyanime: "456", myanimelist: "123" });
    const localA = identity("local:1", { myanimelist: "123" });
    const localB = identity("local:2", { myanimelist: "123" });
    const result = reconcileStreamingAccountSnapshot(snapshot(incoming), [localA, localB]);

    expect(result.anime.map((anime) => anime.id)).toEqual(["yummyanime:456"]);
    expect(result.entries[0]?.animeId).toBe("yummyanime:456");
  });
});
