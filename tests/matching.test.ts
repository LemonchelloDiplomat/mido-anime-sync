import { describe, expect, it } from "vitest";
import { findAnimeMatches, normalizeAnimeTitle } from "../src/core/matching.js";
import type { AnimeIdentity } from "../src/core/types.js";

function createAnime(overrides: Partial<AnimeIdentity> = {}): AnimeIdentity {
  return {
    id: crypto.randomUUID(),
    titles: {
      english: "Death Note",
      romaji: "Death Note",
      synonyms: [],
    },
    externalIds: {},
    year: 2006,
    format: "TV",
    episodes: 37,
    ...overrides,
  };
}

describe("anime matching", () => {
  it("normalizes titles", () => {
    expect(normalizeAnimeTitle("Death Note!")).toBe("death note");
    expect(normalizeAnimeTitle("  DEATH   NOTE ")).toBe("death note");
  });

  it("finds a high-confidence match", () => {
    const source = createAnime({ id: "source" });
    const candidate = createAnime({ id: "candidate" });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("high");
    expect(matches[0]?.score).toBe(95);
  });

  it("does not automatically trust a different release year", () => {
    const source = createAnime({ id: "source" });
    const candidate = createAnime({
      id: "candidate",
      year: 2015,
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
  });

  it("reduces confidence when formats differ", () => {
    const source = createAnime({ id: "source" });
    const candidate = createAnime({
      id: "candidate",
      format: "MOVIE",
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches[0]?.confidence).toBe("review");
  });

  it("matches identical external IDs from the same service", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches[0]?.confidence).toBe("high");
    expect(matches[0]?.score).toBe(100);
  });

  it("requires review when shared external IDs have conflicting titles", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
      titles: {
        english: "Naruto",
        synonyms: [],
      },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain("Названия различаются");
  });

  it("requires review when shared external IDs have conflicting years", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
      year: 2015,
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain("Годы выхода различаются");
  });

  it("requires review when shared external IDs have conflicting formats", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
      format: "MOVIE",
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain("Форматы различаются");
  });

  it("requires review when shared external IDs have conflicting episode counts", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
      episodes: 12,
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain("Количество эпизодов различается");
  });

  it("does not compare IDs from different services directly", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { anilist: "123" },
      titles: {
        english: "Completely Different Anime",
        synonyms: [],
      },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(0);
  });

  it("does not match an anime with itself", () => {
    const anime = createAnime({ id: "same" });

    expect(findAnimeMatches(anime, [anime])).toHaveLength(0);
  });

  it("returns matches ordered by score", () => {
    const source = createAnime({ id: "source" });

    const weaker = createAnime({
      id: "weaker",
      year: null,
    });

    const stronger = createAnime({
      id: "stronger",
    });

    const matches = findAnimeMatches(source, [weaker, stronger]);

    expect(matches[0]?.anime.id).toBe("stronger");
  });

  it("requires review when the same service has conflicting external IDs", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: "123" },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "456" },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain(
      "Внешние ID различаются: myanimelist",
    );
  });

  it("requires review when one external ID matches but another conflicts", () => {
    const source = createAnime({
      id: "source",
      externalIds: {
        myanimelist: "123",
        anilist: "456",
      },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: {
        myanimelist: "123",
        anilist: "789",
      },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("review");
    expect(matches[0]?.reasons).toContain("Внешние ID различаются: anilist");
  });

  it("ignores UNKNOWN format when checking identity conflicts", () => {
    const source = createAnime({
      id: "source",
      format: "UNKNOWN",
    });

    const candidate = createAnime({
      id: "candidate",
      format: "TV",
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons).not.toContain("Форматы различаются");
  });

  it("matches external IDs with surrounding whitespace", () => {
    const source = createAnime({
      id: "source",
      externalIds: { myanimelist: " 123 " },
    });

    const candidate = createAnime({
      id: "candidate",
      externalIds: { myanimelist: "123" },
    });

    const matches = findAnimeMatches(source, [candidate]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe("high");
    expect(matches[0]?.score).toBe(100);
  });
});
