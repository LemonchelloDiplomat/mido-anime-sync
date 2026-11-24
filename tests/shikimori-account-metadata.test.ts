import { describe, expect, it } from "vitest";
import { parseShikimoriAccountList } from "../src/services/shikimori-account.js";

describe("Shikimori expanded metadata mapping", () => {
  it("stores source-specific rating, themes, studios, season and release details", () => {
    const snapshot = parseShikimoriAccountList([{
      id: 7,
      status: "completed",
      score: 9,
      episodes: 26,
      rewatches: 1,
      anime: {
        id: 185,
        malId: 185,
        name: "Initial D First Stage",
        russian: "Инициал Ди: Стадия первая",
        english: "Initial D First Stage",
        japanese: "頭文字D",
        synonyms: ["Initial D"],
        kind: "tv",
        status: "released",
        episodes: 26,
        episodes_aired: 26,
        duration: 25,
        score: "8.63",
        rating: "pg_13",
        origin: "manga",
        season: "spring_1998",
        franchise: "initial_d",
        is_censored: false,
        aired_on: "1998-04-19",
        aired_on_parts: { year: 1998, month: 4, day: 19 },
        released_on: "1998-12-06",
        released_on_parts: { year: 1998, month: 12, day: 6 },
        description: "Takumi is a young street racer.",
        description_html: "<p>Takumi is a young street racer.</p>",
        genres: [
          { id: 1, name: "Drama", russian: "Драма", kind: "genre" },
          { id: 2, name: "Racing", russian: "Гонки", kind: "theme" },
          { id: 3, name: "Seinen", russian: "Сэйнэн", kind: "demographic" },
        ],
        studios: [{ id: 14, name: "Gallop" }],
        licensors: ["DEEP"],
        opengraph_image_url: "https://shikimori.one/poster.jpg",
        image: { original: "https://shikimori.one/poster.jpg" },
      },
    }], "2026-11-25T00:00:00.000Z");

    const anime = snapshot.anime[0]!;
    expect(anime.titles.english).toBe("Initial D First Stage");
    expect(anime.titles.native).toBe("頭文字D");
    expect(anime.ageRating).toBe("PG13");
    expect(anime.averageScore).toBe(8.63);
    expect(anime.providerScores?.shikimori?.averageScore?.normalizedValue).toBe(86.3);
    expect(anime.season).toBe("SPRING");
    expect(anime.seasonYear).toBe(1998);
    expect(anime.durationMinutes).toBe(25);
    expect(anime.episodesAired).toBe(26);
    expect(anime.themes).toEqual(["Гонки"]);
    expect(anime.demographics).toEqual(["Сэйнэн"]);
    expect(anime.studios?.[0]?.name).toBe("Gallop");
    expect(anime.licensors?.[0]?.name).toBe("DEEP");
    expect(anime.endDate).toBe("1998-12-06");
    expect(anime.providerMetadata?.shikimori?.franchise).toBe("initial_d");
  });
});
