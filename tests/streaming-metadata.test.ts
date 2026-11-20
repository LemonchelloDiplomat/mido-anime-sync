import { describe, expect, it } from "vitest";
import type { AnimeIdentity } from "../src/core/types.js";
import type { StreamingTitle } from "../src/services/streaming-provider.js";
import { applyFallbackMetadata } from "../src/services/streaming-metadata.js";

function identity(id: string, year: number, score: number): AnimeIdentity {
  return {
    id: "anilist:" + id,
    titles: { english: "Example Anime", romaji: "Example Anime", synonyms: ["Example"], native: "例アニメ" },
    externalIds: { anilist: id },
    year,
    posterUrl: "https://images.example/" + id + ".jpg",
    averageScore: score,
  };
}

function streamingTitle(year: number | null = 2024): StreamingTitle {
  return {
    provider: "animego",
    externalId: "example",
    url: "https://animego.org/anime/example",
    title: "Example Anime",
    alternativeTitles: ["Example"],
    posterUrl: null,
    averageScore: null,
    year,
  };
}

describe("streaming catalogue fallback metadata", () => {
  it("fills missing poster and rating only on an exact title match", () => {
    const result = applyFallbackMetadata(streamingTitle(), [identity("1", 2024, 8.7)]);
    expect(result.posterUrl).toBe("https://images.example/1.jpg");
    expect(result.averageScore).toBe(8.7);
    expect(result.posterSource).toBe("AniList");
    expect(result.scoreSource).toBe("AniList");
    expect(result.identity?.externalIds.anilist).toBe("1");
  });

  it("does not guess when same-title entries remain ambiguous", () => {
    const result = applyFallbackMetadata(streamingTitle(null), [
      identity("1", 2023, 8.1),
      identity("2", 2024, 8.7),
    ]);
    expect(result.posterUrl).toBeNull();
    expect(result.averageScore).toBeNull();
  });

  it("keeps provider metadata when it already exists", () => {
    const item = { ...streamingTitle(), posterUrl: "https://provider.example/poster.jpg", averageScore: 7.4 };
    const result = applyFallbackMetadata(item, [identity("1", 2024, 9.1)]);
    expect(result.posterUrl).toBe("https://provider.example/poster.jpg");
    expect(result.averageScore).toBe(7.4);
  });

  it("prefers an exact AniList poster for AnimeGO while preserving the provider rating", () => {
    const item = { ...streamingTitle(), posterUrl: "https://animego.example/broken.jpg", averageScore: 7.4, scoreSource: "AnimeGO" };
    const result = applyFallbackMetadata(item, [identity("1", 2024, 9.1)], { preferPoster: true });
    expect(result.posterUrl).toBe("https://images.example/1.jpg");
    expect(result.posterSource).toBe("AniList");
    expect(result.averageScore).toBe(7.4);
    expect(result.scoreSource).toBe("AnimeGO");
  });

  it("matches Russian and English aliases without accepting partial title matches", () => {
    const russianItem = { ...streamingTitle(), title: "Примерное аниме", alternativeTitles: ["Example Anime"] };
    const result = applyFallbackMetadata(russianItem, [identity("1", 2024, 8.7)]);
    expect(result.posterUrl).toBe("https://images.example/1.jpg");
    const unrelated = { ...streamingTitle(), title: "Example Anime: Another Story", alternativeTitles: [] };
    expect(applyFallbackMetadata(unrelated, [identity("1", 2024, 8.7)]).posterUrl).toBeNull();
  });
});
