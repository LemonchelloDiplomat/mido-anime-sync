import { describe, expect, it } from "vitest";
import type { StreamingTitle } from "../src/services/streaming-provider.js";
import { applyStreamingPosterFallback } from "../src/services/streaming-metadata.js";

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
