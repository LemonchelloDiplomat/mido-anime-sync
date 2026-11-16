import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY_FILTERS, filterLibrary, type LibraryFilters } from "../src/core/library-filter.js";
import type { AnimeIdentity, AnimeListEntry } from "../src/core/types.js";

function item(overrides: Partial<AnimeIdentity> = {}, entry?: Partial<AnimeListEntry>) {
  const anime: AnimeIdentity = {
    id: "anime-1",
    titles: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren", synonyms: ["Frieren"], },
    externalIds: {},
    year: 2023,
    format: "TV",
    episodes: 28,
    genres: ["Фэнтези", "Приключения"],
    ageRating: "PG13",
    averageScore: 8.9,
    startDate: "2023-09-29",
    releaseStatus: "RELEASED",
    ...overrides,
  };
  const listEntry: AnimeListEntry = {
    animeId: anime.id, status: "COMPLETED", progress: 28, score: 95,
    favorite: false, updatedAt: "2026-01-01T00:00:00.000Z", source: "local",
    ...entry,
  };
  return { anime, entry: listEntry };
}

function filters(overrides: Partial<LibraryFilters> = {}): LibraryFilters {
  return { ...DEFAULT_LIBRARY_FILTERS, ...overrides };
}

describe("library filtering", () => {
  it("searches across English, romaji and synonym titles", () => {
    expect(filterLibrary([item()], filters({ query: "sousou" }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ query: "frieren" }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ query: "naruto" }))).toHaveLength(0);
  });

  it("applies year bounds and excludes unknown years when a bound is narrowed", () => {
    expect(filterLibrary([item()], filters({ yearFrom: 2020, yearTo: 2024 }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ yearFrom: 2024 }))).toHaveLength(0);
    expect(filterLibrary([item({ year: null })], filters({ yearFrom: 2020 }))).toHaveLength(0);
  });

  it("supports include-any and strict include-all genre matching", () => {
    const selected = { "Фэнтези": "include", "Комедия": "include" } as const;
    expect(filterLibrary([item()], filters({ genres: selected, strictGenres: false }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ genres: selected, strictGenres: true }))).toHaveLength(0);
  });

  it("excludes titles with any excluded genre", () => {
    expect(filterLibrary([item()], filters({ genres: { "Фэнтези": "exclude" } }))).toHaveLength(0);
  });

  it("filters format, release status and age rating", () => {
    expect(filterLibrary([item()], filters({ formats: ["TV"], releaseStatuses: ["RELEASED"], ageRatings: ["PG13"] }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ formats: ["MOVIE"] }))).toHaveLength(0);
    expect(filterLibrary([item()], filters({ ageRatings: ["R+"] }))).toHaveLength(0);
  });

  it("filters episode count buckets", () => {
    expect(filterLibrary([item()], filters({ episodeRanges: ["LONG"] }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ episodeRanges: ["SHORT"] }))).toHaveLength(0);
    expect(filterLibrary([item({ episodes: null })], filters({ episodeRanges: ["LONG"] }))).toHaveLength(0);
  });

  it("filters entries by personal list status", () => {
    expect(filterLibrary([item()], filters({ status: "COMPLETED" }))).toHaveLength(1);
    expect(filterLibrary([item()], filters({ status: "WATCHING" }))).toHaveLength(0);
  });

  it("checks recent releases against the supplied clock", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(filterLibrary([item({ startDate: "2026-04-01" })], filters({ recentOnly: true }), now)).toHaveLength(1);
    expect(filterLibrary([item({ startDate: "2025-01-01" })], filters({ recentOnly: true }), now)).toHaveLength(0);
  });
});
