import { describe, expect, it } from "vitest";
import { parseAniListAccountList } from "../src/services/anilist-account.js";

describe("AniList account list importer", () => {
  it("normalizes personal scores, statuses, favorites and external IDs", () => {
    const snapshot = parseAniListAccountList([{
      id: 77,
      status: "REPEATING",
      score: 8.5,
      progress: 12,
      repeat: 1,
      notes: "Rewatch with director commentary",
      updatedAt: 1794830400,
      startedAt: { year: 2026, month: 1, day: 2 },
      completedAt: { year: 2026, month: 2, day: 3 },
      media: {
        id: 154587,
        idMal: 52991,
        title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End", native: "葬送のフリーレン" },
        synonyms: ["Frieren"],
        format: "TV",
        status: "FINISHED",
        episodes: 28,
        seasonYear: 2023,
        startDate: { year: 2023, month: 9, day: 29 },
        averageScore: 93,
        genres: ["Adventure", "Drama"],
        isFavourite: true,
        coverImage: { extraLarge: "https://example.com/frieren.jpg" },
      },
    }], "POINT_10_DECIMAL", "2026-11-17T00:00:00.000Z");

    expect(snapshot.anime[0]).toMatchObject({
      id: "anilist:154587",
      externalIds: { anilist: "154587", myanimelist: "52991" },
      year: 2023,
      format: "TV",
      episodes: 28,
      averageScore: 9.3,
      posterUrl: "https://example.com/frieren.jpg",
    });
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "anilist:154587",
      status: "REWATCHING",
      progress: 12,
      score: 85,
      favorite: true,
      source: "anilist",
      sourceMetadata: {
        anilistEntryId: 77,
        repeat: 1,
        notes: "Rewatch with director commentary",
        scoreFormat: "POINT_10_DECIMAL",
        startedAt: "2026-01-02",
        completedAt: "2026-02-03",
      },
    });
    expect(snapshot.sourceEntries).toEqual(snapshot.entries);
  });

  it("supports all AniList score formats", () => {
    const make = (score: number) => [{
      id: 1, status: "PLANNING", score, progress: 0, repeat: 0, updatedAt: 1,
      media: { id: 1, idMal: null, title: { romaji: "Title", english: null, native: null } },
    }];
    expect(parseAniListAccountList(make(80), "POINT_100").entries[0]?.score).toBe(80);
    expect(parseAniListAccountList(make(8), "POINT_10").entries[0]?.score).toBe(80);
    expect(parseAniListAccountList(make(4), "POINT_5").entries[0]?.score).toBe(80);
    expect(parseAniListAccountList(make(2.4), "POINT_3").entries[0]?.score).toBe(80);
  });

  it("rejects duplicate AniList media IDs", () => {
    const entry = {
      id: 1, status: "PLANNING", score: 0, progress: 0, repeat: 0, updatedAt: 1,
      media: { id: 1, idMal: null, title: { romaji: "Title", english: null, native: null } },
    };
    expect(() => parseAniListAccountList([entry, entry], "POINT_100")).toThrow(/повторяющийся ID/);
  });
});
