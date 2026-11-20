import { describe, expect, it } from "vitest";
import type { AnimeIdentity } from "../src/core/types.js";
import type { StreamingTitle } from "../src/services/streaming-provider.js";
import { applyFallbackMetadata, applyStreamingPosterFallback } from "../src/services/streaming-metadata.js";

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

describe("independent streaming poster matching", () => {
  const animeGoItem: StreamingTitle = {
    provider: "animego",
    externalId: "naruto-shippuden",
    url: "https://animego.example/anime/naruto-shippuden",
    title: "Наруто: Ураганные хроники",
    alternativeTitles: ["Naruto Shippuden"],
    posterUrl: "https://animego.example/broken-poster.jpg",
    averageScore: 8.1,
    scoreSource: "AnimeGO",
    year: 2007,
  };

  it("borrows an exact-match AnixART poster without replacing AnimeGO metadata", () => {
    const source: StreamingTitle = {
      provider: "anixart",
      externalId: "123-naruto-shippuden.html",
      url: "https://anixart.site/123-naruto-shippuden.html",
      title: "Naruto Shippuden",
      alternativeTitles: [],
      posterUrl: "https://anixart.site/posters/naruto.jpg",
      averageScore: 8.8,
      scoreSource: "AnixART",
      year: 2007,
    };
    const result = applyStreamingPosterFallback(animeGoItem, [source]);
    expect(result.posterUrl).toBe(source.posterUrl);
    expect(result.posterSource).toBe("AnixART");
    expect(result.fallbackPosterUrl).toBe(animeGoItem.posterUrl);
    expect(result.provider).toBe("animego");
    expect(result.externalId).toBe(animeGoItem.externalId);
    expect(result.url).toBe(animeGoItem.url);
    expect(result.averageScore).toBe(8.1);
    expect(result.scoreSource).toBe("AnimeGO");
    expect(result.identity).toBeUndefined();
  });

  it("does not use partial title matches", () => {
    const source: StreamingTitle = {
      provider: "anixart",
      externalId: "456-naruto.html",
      url: "https://anixart.site/456-naruto.html",
      title: "Naruto",
      alternativeTitles: [],
      posterUrl: "https://anixart.site/posters/naruto.jpg",
      year: 2002,
    };
    expect(applyStreamingPosterFallback(animeGoItem, [source]).posterUrl).toBe(animeGoItem.posterUrl);
  });

  it("rejects same-title candidates from a different year", () => {
    const source: StreamingTitle = {
      provider: "anixart",
      externalId: "789-naruto-shippuden.html",
      url: "https://anixart.site/789-naruto-shippuden.html",
      title: "Naruto Shippuden",
      alternativeTitles: [],
      posterUrl: "https://anixart.site/posters/wrong-year.jpg",
      year: 2008,
    };
    expect(applyStreamingPosterFallback(animeGoItem, [source]).posterUrl).toBe(animeGoItem.posterUrl);
  });

  it("rejects ambiguous exact-title matches", () => {
    const makeSource = (id: string): StreamingTitle => ({
      provider: "anixart",
      externalId: id + "-naruto-shippuden.html",
      url: "https://anixart.site/" + id + "-naruto-shippuden.html",
      title: "Naruto Shippuden",
      alternativeTitles: [],
      posterUrl: "https://anixart.site/posters/" + id + ".jpg",
      year: 2007,
    });
    expect(applyStreamingPosterFallback(animeGoItem, [makeSource("1"), makeSource("2")]).posterUrl)
      .toBe(animeGoItem.posterUrl);
  });
});

describe("streaming catalogue fallback metadata", () => {
  it("fills missing poster and rating only on an exact title match", () => {
    const result = applyFallbackMetadata(streamingTitle(), [identity("1", 2024, 8.7)]);
    expect(result.posterUrl).toBe("https://images.example/1.jpg");
    expect(result.averageScore).toBe(8.7);
    expect(result.year).toBe(2024);
    expect(result.posterSource).toBe("AniList");
    expect(result.fallbackPosterUrl).toBe("https://images.example/1.jpg");
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
    expect(result.fallbackPosterUrl).toBe("https://animego.example/broken.jpg");
    expect(result.averageScore).toBe(7.4);
    expect(result.scoreSource).toBe("AnimeGO");
  });


  it("keeps a verified AniList cover as a secondary fallback for a broken AnixART poster", () => {
    const item = {
      ...streamingTitle(),
      provider: "anixart" as const,
      posterUrl: "https://anixart.site/uploads/broken-cover.jpg",
      averageScore: 8.2,
      scoreSource: "AnixART",
    };
    const result = applyFallbackMetadata(item, [identity("1", 2024, 9.1)]);
    expect(result.posterUrl).toBe("https://anixart.site/uploads/broken-cover.jpg");
    expect(result.fallbackPosterUrl).toBe("https://images.example/1.jpg");
    expect(result.averageScore).toBe(8.2);
    expect(result.scoreSource).toBe("AnixART");
  });

  it("does not attach a fallback poster when exact-title candidates are ambiguous", () => {
    const item = { ...streamingTitle(null), posterUrl: "https://provider.example/poster.jpg" };
    const result = applyFallbackMetadata(item, [
      identity("1", 2023, 8.1),
      identity("2", 2024, 8.7),
    ]);
    expect(result.fallbackPosterUrl).toBeUndefined();
  });

  it("matches Russian and English aliases without accepting partial title matches", () => {
    const russianItem = { ...streamingTitle(), title: "Примерное аниме", alternativeTitles: ["Example Anime"] };
    const result = applyFallbackMetadata(russianItem, [identity("1", 2024, 8.7)]);
    expect(result.posterUrl).toBe("https://images.example/1.jpg");
    const unrelated = { ...streamingTitle(), title: "Example Anime: Another Story", alternativeTitles: [] };
    expect(applyFallbackMetadata(unrelated, [identity("1", 2024, 8.7)]).posterUrl).toBeNull();
  });
});
