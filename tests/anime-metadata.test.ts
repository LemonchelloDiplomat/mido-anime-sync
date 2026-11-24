import { describe, expect, it } from "vitest";
import { createAnimeProviderScore, mergeAnimeMetadata } from "../src/core/anime-metadata.js";
import { validateSnapshot } from "../src/storage/snapshot-validation.js";
import type { AnimeIdentity } from "../src/core/types.js";

const base: AnimeIdentity = {
  id: "mal:1",
  titles: { english: "Cowboy Bebop", synonyms: [] },
  externalIds: { myanimelist: "1" },
};

describe("provider-aware anime metadata", () => {
  it("keeps native score scales and derives a comparable 0-100 value", () => {
    expect(createAnimeProviderScore(8.42, 10, { kind: "mean", voteCount: 1000 })).toEqual({
      value: 8.42,
      scale: 10,
      normalizedValue: 84.2,
      kind: "mean",
      voteCount: 1000,
    });
    expect(createAnimeProviderScore(86, 100).normalizedValue).toBe(86);
  });

  it("merges metadata from different providers without overwriting their scores", () => {
    const merged = mergeAnimeMetadata(
      {
        ...base,
        genres: ["Action"],
        providerScores: {
          myanimelist: { meanScore: createAnimeProviderScore(8.4, 10, { kind: "mean" }) },
        },
        providerMetadata: { myanimelist: { rank: 42 } },
      },
      {
        ...base,
        externalIds: { myanimelist: "1", anilist: "1" },
        genres: ["Drama"],
        providerScores: {
          anilist: { averageScore: createAnimeProviderScore(85, 100, { kind: "average" }) },
        },
        providerMetadata: { anilist: { tags: [{ name: "Space" }] } },
      },
    );

    expect(merged.genres).toEqual(["Action", "Drama"]);
    expect(merged.providerScores?.myanimelist?.meanScore?.value).toBe(8.4);
    expect(merged.providerScores?.anilist?.averageScore?.value).toBe(85);
    expect(merged.providerMetadata).toEqual({
      myanimelist: { rank: 42 },
      anilist: { tags: [{ name: "Space" }] },
    });
  });

  it("preserves existing named metadata when preferIncoming is false while retaining new values", () => {
    const existing: AnimeIdentity = {
      ...base,
      tags: [{ name: "Space", category: "Setting", rank: 90 }],
      studios: [{ name: "Sunrise", externalId: "14", role: "animation" }],
      staff: [{ name: "Director A", externalId: "5", role: "Director", language: "Japanese" }],
    };
    const incoming: AnimeIdentity = {
      ...base,
      tags: [
        { name: "Space", category: "Setting", rank: 40 },
        { name: "Found Family", category: "Theme", rank: 80 },
      ],
      studios: [
        { name: "Sunrise", externalId: "14", role: "animation" },
        { name: "New Studio", externalId: "15", role: "production" },
      ],
      staff: [
        { name: "Director A", externalId: "5", role: "Director", language: "Japanese" },
        { name: "Director B", externalId: "6", role: "Director", language: "Japanese" },
      ],
    };

    const merged = mergeAnimeMetadata(existing, incoming, { preferIncoming: false });

    expect(merged.tags).toEqual([
      { name: "Space", category: "Setting", rank: 90 },
      { name: "Found Family", category: "Theme", rank: 80 },
    ]);
    expect(merged.studios).toEqual([
      { name: "Sunrise", externalId: "14", role: "animation" },
      { name: "New Studio", externalId: "15", role: "production" },
    ]);
    expect(merged.staff).toEqual([
      { name: "Director A", externalId: "5", role: "Director", language: "Japanese" },
      { name: "Director B", externalId: "6", role: "Director", language: "Japanese" },
    ]);
  });

  it("accepts expanded provider metadata in a legacy V4 snapshot without migration loss", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-25T00:00:00.000Z",
      anime: [{
        ...base,
        year: 1998,
        format: "TV",
        episodes: 26,
        episodesAired: 26,
        durationMinutes: 24,
        season: "SPRING",
        seasonYear: 1998,
        endDate: "1999-04-24",
        sourceMaterial: "Original",
        countryOfOrigin: "JP",
        synopsis: "A bounty hunter crew travels through space.",
        genres: ["Action", "Sci-Fi"],
        themes: ["Space"],
        demographics: ["Seinen"],
        tags: [{ name: "Space", category: "Setting", rank: 85 }],
        studios: [{ name: "Sunrise", externalId: "14" }],
        providerScores: {
          myanimelist: {
            averageScore: createAnimeProviderScore(8.75, 10, { kind: "average", voteCount: 100000 }),
          },
          anilist: {
            averageScore: createAnimeProviderScore(86, 100, { kind: "average" }),
          },
        },
        providerMetadata: {
          myanimelist: { rank: 46, popularity: 43, members: 1980000, favorites: 82000 },
          anilist: { meanScore: 85, favourites: 5000 },
        },
      }],
      entries: [],
      sourceEntries: [],
      conflictResolutions: [],
      animeRelations: [],
    });

    expect(snapshot.anime[0]?.providerScores?.myanimelist?.averageScore?.scale).toBe(10);
    expect(snapshot.anime[0]?.providerScores?.anilist?.averageScore?.normalizedValue).toBe(86);
    expect(snapshot.anime[0]?.studios?.[0]?.name).toBe("Sunrise");
  });

  it("rejects invalid provider score scales", () => {
    expect(() => validateSnapshot({
      schemaVersion: 4,
      anime: [{
        ...base,
        providerScores: {
          myanimelist: { averageScore: { value: 8, scale: 0, normalizedValue: 80 } },
        },
      }],
      entries: [],
    })).toThrow(/provider score/i);
  });

  it("bounds raw provider metadata to prevent unbounded library growth", () => {
    expect(() => validateSnapshot({
      schemaVersion: 4,
      anime: [{
        ...base,
        providerMetadata: { myanimelist: { raw: "x".repeat(140000) } },
      }],
      entries: [],
    })).toThrow(/too large|storage limit/i);
  });
});
