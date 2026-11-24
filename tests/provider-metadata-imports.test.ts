import { describe, expect, it } from "vitest";
import { parseAniListAccountList } from "../src/services/anilist-account.js";
import { parseMyAnimeListApiList } from "../src/services/myanimelist-account.js";

describe("provider-native metadata import", () => {
  it("imports expanded MAL catalog fields and keeps its 10-point score scale", () => {
    const snapshot = parseMyAnimeListApiList([{
      node: {
        id: 1,
        title: "Cowboy Bebop",
        alternative_titles: { en: "Cowboy Bebop", ja: "カウボーイビバップ", synonyms: ["Cowboy Bebop: The Movie"] },
        start_date: "1998-04-03",
        end_date: "1999-04-24",
        start_season: { season: "spring", year: 1998 },
        media_type: "tv",
        status: "finished_airing",
        num_episodes: 26,
        mean: 8.75,
        rank: 46,
        popularity: 43,
        num_list_users: 1980000,
        num_scoring_users: 100000,
        genres: [{ id: 1, name: "Action" }],
        themes: [{ id: 1, name: "Space" }],
        demographics: [{ id: 1, name: "Seinen" }],
        studios: [{ id: 14, name: "Sunrise" }],
        producers: [{ id: 23, name: "Bandai Visual" }],
        licensors: [{ id: 24, name: "Funimation" }],
        source: "Original",
        rating: "pg_13",
        synopsis: "A bounty hunter crew travels through space.",
        background: "A longer production background.",
      },
      list_status: {
        status: "completed",
        score: 9,
        num_episodes_watched: 26,
      },
    }], "2026-11-25T00:00:00.000Z");

    const anime = snapshot.anime[0]!;
    expect(anime.providerScores?.myanimelist?.meanScore).toMatchObject({
      value: 8.75, scale: 10, normalizedValue: 87.5, voteCount: 100000,
    });
    expect(anime.studios?.[0]?.name).toBe("Sunrise");
    expect(anime.themes).toEqual(["Space"]);
    expect(anime.demographics).toEqual(["Seinen"]);
    expect(anime.endDate).toBe("1999-04-24");
    expect(anime.providerMetadata?.myanimelist?.rating).toBe("pg_13");
  });

  it("imports expanded AniList media fields and preserves its 100-point score scale", () => {
    const snapshot = parseAniListAccountList([{
      id: 12,
      status: "COMPLETED",
      score: 86,
      progress: 26,
      repeat: 0,
      updatedAt: 1795564800,
      media: {
        id: 1,
        idMal: 1,
        isFavourite: false,
        title: { romaji: "Cowboy Bebop", english: "Cowboy Bebop", native: "カウボーイビバップ" },
        synonyms: ["Cowboy Bebop"],
        format: "TV",
        status: "FINISHED",
        episodes: 26,
        seasonYear: 1998,
        startDate: { year: 1998, month: 4, day: 3 },
        endDate: { year: 1999, month: 4, day: 24 },
        averageScore: 86,
        meanScore: 85,
        popularity: 1000,
        favourites: 200,
        description: "A bounty hunter crew travels through space.",
        season: "SPRING",
        duration: 24,
        countryOfOrigin: "JP",
        source: "ORIGINAL",
        bannerImage: "https://example.com/banner.jpg",
        isAdult: false,
        tags: [{ name: "Space", rank: 90, isGeneralSpoiler: false, isAdultSpoiler: false, category: "Setting" }],
        studios: { nodes: [{ id: 14, name: "Sunrise", isAnimationStudio: true }] },
        staff: { edges: [{ role: "Director", node: { id: 5, name: { full: "Shinichiro Watanabe" } } }] },
        genres: ["Action", "Sci-Fi"],
        coverImage: { extraLarge: "https://example.com/cover.jpg", large: null },
      },
    }], "POINT_100", "2026-11-25T00:00:00.000Z");

    const anime = snapshot.anime[0]!;
    expect(anime.providerScores?.anilist?.averageScore).toMatchObject({
      value: 86, scale: 100, normalizedValue: 86,
    });
    expect(anime.providerScores?.anilist?.meanScore?.value).toBe(85);
    expect(anime.studios?.[0]?.name).toBe("Sunrise");
    expect(anime.staff?.[0]?.role).toBe("Director");
    expect(anime.tags?.[0]?.name).toBe("Space");
    expect(anime.endDate).toBe("1999-04-24");
    expect(anime.countryOfOrigin).toBe("JP");
  });
});
