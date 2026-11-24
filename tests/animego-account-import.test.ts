import { describe, expect, it } from "vitest";
import { mergeAnimeGoTitleMetadata, normalizeAnimeGoAccountList, normalizeAnimeGoFetchedAt } from "../src/services/animego-account-import.js";

describe("AnimeGO account-list import", () => {
  it("normalizes native Unix-style fetch timestamps to valid snapshot dates", () => {
    const fallback = new Date("2026-11-25T12:00:00.000Z");
    expect(normalizeAnimeGoFetchedAt("unix:1795608000", fallback)).toBe(fallback.toISOString());
    expect(normalizeAnimeGoFetchedAt("2026-11-24T08:30:00.000Z", fallback)).toBe("2026-11-24T08:30:00.000Z");
  });

  it("fills missing catalog fields without overwriting valid local metadata and repairs placeholder posters", () => {
    const current = normalizeAnimeGoAccountList({
      listType: 1,
      sourceUrl: "https://animego.me/profile/test?type=1",
      entries: [{ animeId: "3642", title: "91 день", posterUrl: "https://cdngos.com" }],
    }).rows[0]!.anime;
    current.year = 2015;
    current.averageScore = 8.4;
    current.posterUrl = "https://cdngos.com";
    const incoming = {
      ...current,
      year: 2016,
      format: "TV" as const,
      episodes: 12,
      genres: ["Экшен", "Драма"],
      ageRating: "R+" as const,
      posterUrl: "https://img.cdngos.com/posters/91-days.jpg",
      averageScore: 9,
      startDate: "2016-07-09",
      releaseStatus: "RELEASED" as const,
    };
    const merged = mergeAnimeGoTitleMetadata(current, incoming);
    expect(merged.year).toBe(2015);
    expect(merged.averageScore).toBe(8.4);
    expect(merged.format).toBe("TV");
    expect(merged.episodes).toBe(12);
    expect(merged.genres).toEqual(["Экшен", "Драма"]);
    expect(merged.posterUrl).toBe("https://img.cdngos.com/posters/91-days.jpg");
    expect(merged.startDate).toBe("2016-07-09");
    expect(merged.releaseStatus).toBe("RELEASED");
  });

  it("maps all six profile list types to the corresponding local status", () => {
    const expected = ["WATCHING", "COMPLETED", "ON_HOLD", "DROPPED", "PLANNING", "REWATCHING"];
    expected.forEach((status, index) => {
      const result = normalizeAnimeGoAccountList({
        listType: index + 1,
        sourceUrl: "https://animego.me/profile/test?type=" + (index + 1),
        entries: [{ animeId: "123", title: "Example" }],
      }, "2026-11-23T12:00:00.000Z");
      expect(result.status).toBe(status);
      expect(result.rows[0]?.entry.status).toBe(status);
    });
  });

  it("preserves exact AnimeGO IDs and personal scores without guessing progress", () => {
    const result = normalizeAnimeGoAccountList({
      listType: 1,
      sourceUrl: "https://animego.me/user/test?type=1",
      entries: [{ animeId: "987", title: "Title", originalTitle: "Original", score: "8", posterUrl: "https://cdn.example/poster.jpg" }],
    }, "2026-11-23T12:00:00.000Z");
    expect(result.rows[0]).toMatchObject({
      anime: { id: "animego:987", externalIds: { animego: "987" }, titles: { romaji: "Title", synonyms: ["Original"] } },
      entry: { status: "WATCHING", score: 80, progress: 0, source: "animego", sourceMetadata: { progressKnown: false, scoreKnown: true, favoriteKnown: false } },
    });
  });


  it("imports episode progress only when AnimeGO explicitly provides it", () => {
    const result = normalizeAnimeGoAccountList({
      listType: 1,
      sourceUrl: "https://animego.me/profile/test?type=1",
      entries: [
        { animeId: "321", title: "Known progress", episodesWatched: 7, episodesTotal: 12 },
        { animeId: "654", title: "Unknown progress", episodesWatched: null, episodesTotal: 24 },
      ],
    }, "2026-11-23T12:00:00.000Z");

    expect(result.rows[0]?.anime.episodes).toBe(12);
    expect(result.rows[0]?.entry).toMatchObject({
      progress: 7,
      sourceMetadata: { progressKnown: true, episodesTotal: 12 },
    });
    expect(result.rows[1]?.entry).toMatchObject({
      progress: 0,
      sourceMetadata: { progressKnown: false, episodesTotal: 24 },
    });
  });

  it("skips malformed and duplicate rows rather than inventing identities", () => {
    const result = normalizeAnimeGoAccountList({
      listType: 5,
      sourceUrl: "https://animego.me/profile/test?type=5",
      entries: [
        { animeId: "1", title: "First" },
        { animeId: "1", title: "Duplicate" },
        { animeId: "bad", title: "Invalid ID" },
        { animeId: "2", title: "" },
      ],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  it("rejects untrusted pages and unsupported list types", () => {
    expect(() => normalizeAnimeGoAccountList({
      listType: 1, sourceUrl: "https://evil.example/profile/test", entries: [],
    })).toThrow(/собственного профиля/i);
    expect(() => normalizeAnimeGoAccountList({
      listType: 9, sourceUrl: "https://animego.me/profile/test", entries: [],
    })).toThrow(/тип списка/i);
  });

  it("rejects oversized payloads", () => {
    expect(() => normalizeAnimeGoAccountList({
      listType: 1,
      sourceUrl: "https://animego.me/profile/test",
      entries: new Array(5001).fill({ animeId: "1", title: "A" }),
    })).toThrow(/5000/);
  });
});
