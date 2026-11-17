import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../src/storage/snapshot-validation.js";
import type { AnimeListEntry, AnimeRelation } from "../src/core/types.js";

function makeEntry(): AnimeListEntry {
  return {
    animeId: "legacy-anime",
    status: "WATCHING",
    progress: 5,
    score: 80,
    favorite: true,
    updatedAt: "2026-11-15T12:00:00.000Z",
    source: "myanimelist",
  };
}

const anime = [
  {
    id: "legacy-anime",
    titles: {
      english: "Legacy Anime",
      synonyms: [],
    },
    externalIds: {},
    episodes: 12,
  },
  {
    id: "legacy-anime-2",
    titles: {
      english: "Legacy Anime 2",
      synonyms: [],
    },
    externalIds: {},
    episodes: 12,
  },
];

function makeRelation(overrides: Partial<AnimeRelation> = {}): AnimeRelation {
  return {
    id: "relation-1",
    sourceAnimeId: "legacy-anime",
    targetAnimeId: "legacy-anime-2",
    type: "SEQUEL",
    seasonNumber: 2,
    partNumber: 1,
    ...overrides,
  };
}

describe("snapshot validation fallback", () => {
  it("restores V2 source entries from entries when sourceEntries is empty", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 2,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [],
    });

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.sourceEntries[0]).toMatchObject({
      animeId: "legacy-anime",
      progress: 5,
      source: "myanimelist",
    });
    expect(snapshot.animeRelations).toEqual([]);
  });

  it("restores V2 source entries when sourceEntries is missing", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 2,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
    });

    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.sourceEntries[0]).toMatchObject({
      animeId: "legacy-anime",
      progress: 5,
    });
    expect(snapshot.animeRelations).toEqual([]);
  });

  it("restores V3 source entries from entries when sourceEntries is empty", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 3,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [],
      conflictResolutions: [],
    });

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.sourceEntries[0]).toMatchObject({
      animeId: "legacy-anime",
      progress: 5,
      source: "myanimelist",
    });
    expect(snapshot.animeRelations).toEqual([]);
  });

  it("keeps existing source entries instead of replacing them with merged entries", () => {
    const sourceEntry = {
      ...makeEntry(),
      progress: 7,
      source: "anilist" as const,
    };

    const snapshot = validateSnapshot({
      schemaVersion: 2,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [sourceEntry],
    });

    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.sourceEntries[0]).toMatchObject({
      progress: 7,
      source: "anilist",
    });
  });

  it("converts V1 snapshots to V4", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 1,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
    });

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.sourceEntries).toHaveLength(1);
    expect(snapshot.conflictResolutions).toEqual([]);
    expect(snapshot.animeRelations).toEqual([]);
  });

  it("converts V3 snapshots to V4 and preserves conflict resolutions", () => {
    const resolution = {
      animeId: "legacy-anime",
      status: "WATCHING",
      fingerprint: "test-fingerprint",
      resolvedAt: "2026-11-15T12:00:00.000Z",
    };

    const snapshot = validateSnapshot({
      schemaVersion: 3,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [makeEntry()],
      conflictResolutions: [resolution],
    });

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.conflictResolutions).toEqual([resolution]);
    expect(snapshot.animeRelations).toEqual([]);
  });
});

describe("anime relation validation", () => {
  it("accepts valid relations in V4 snapshots", () => {
    const relation = makeRelation();

    const snapshot = validateSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [makeEntry()],
      conflictResolutions: [],
      animeRelations: [relation],
    });

    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.animeRelations).toEqual([relation]);
  });

  it("accepts relations without optional season and part numbers", () => {
    const relation: AnimeRelation = {
      id: "relation-1",
      sourceAnimeId: "legacy-anime",
      targetAnimeId: "legacy-anime-2",
      type: "SEQUEL",
    };

    const snapshot = validateSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [makeEntry()],
      conflictResolutions: [],
      animeRelations: [relation],
    });

    expect(snapshot.animeRelations).toEqual([relation]);
  });

  it("rejects relations referencing missing anime", () => {
    const relation = makeRelation({
      targetAnimeId: "missing-anime",
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [relation],
      }),
    ).toThrow("Anime relation references missing anime");
  });

  it("rejects relations referencing themselves", () => {
    const relation = makeRelation({
      targetAnimeId: "legacy-anime",
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [relation],
      }),
    ).toThrow("Anime relation cannot reference itself");
  });

  it("rejects duplicate relation IDs", () => {
    const first = makeRelation();
    const second = makeRelation({
      sourceAnimeId: "legacy-anime-2",
      targetAnimeId: "legacy-anime",
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [first, second],
      }),
    ).toThrow("Duplicate anime relation ID");
  });

  it("rejects duplicate relations", () => {
    const first = makeRelation();
    const second = makeRelation({
      id: "relation-2",
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [first, second],
      }),
    ).toThrow("Duplicate anime relation");
  });

  it("rejects invalid relation types", () => {
    const relation = makeRelation({
      type: "UNKNOWN" as AnimeRelation["type"],
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [relation],
      }),
    ).toThrow("Invalid anime relation type");
  });

  it("rejects invalid season numbers", () => {
    const relation = makeRelation({
      seasonNumber: 0,
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [relation],
      }),
    ).toThrow("Invalid anime relation season number");
  });

  it("rejects invalid part numbers", () => {
    const relation = makeRelation({
      partNumber: -1,
    });

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [relation],
      }),
    ).toThrow("Invalid anime relation part number");
  });

  it("rejects V4 snapshots without animeRelations", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
      }),
    ).toThrow("Invalid anime relations list");
  });
});

describe("source metadata validation", () => {
  it("preserves valid source metadata", () => {
    const entry: AnimeListEntry = {
      ...makeEntry(),
      sourceMetadata: {
        externalStatus: "watching",
        customValue: 123,
      },
    };

    const snapshot = validateSnapshot({
      schemaVersion: 4,
      anime,
      entries: [entry],
      sourceEntries: [entry],
      conflictResolutions: [],
      animeRelations: [],
    });

    expect(snapshot.entries[0]?.sourceMetadata).toEqual({
      externalStatus: "watching",
      customValue: 123,
    });
  });

  it("rejects array source metadata", () => {
    const entry = {
      ...makeEntry(),
      sourceMetadata: [],
    };

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [entry],
        sourceEntries: [entry],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Invalid source metadata");
  });

  it("rejects null source metadata", () => {
    const entry = {
      ...makeEntry(),
      sourceMetadata: null,
    };

    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [entry],
        sourceEntries: [entry],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Invalid source metadata");
  });
});

describe("anime identity validation", () => {
  const makeSnapshot = (animeOverrides: Record<string, unknown> = {}) => ({
    schemaVersion: 4,
    anime: [{ ...anime[0], ...animeOverrides }],
    entries: [makeEntry()],
    sourceEntries: [makeEntry()],
    conflictResolutions: [],
    animeRelations: [],
  });

  it("rejects non-string anime title synonyms", () => {
    expect(() =>
      validateSnapshot(
        makeSnapshot({
          titles: { english: "Anime", synonyms: ["Valid", 123] },
        }),
      ),
    ).toThrow("Invalid anime record");
  });

  it("rejects non-string optional anime titles", () => {
    expect(() =>
      validateSnapshot(
        makeSnapshot({
          titles: { english: 123, synonyms: [] },
        }),
      ),
    ).toThrow("Invalid anime record");
  });

  it("rejects malformed external IDs", () => {
    expect(() =>
      validateSnapshot(
        makeSnapshot({
          externalIds: { myanimelist: 123 },
        }),
      ),
    ).toThrow("Invalid anime external ID");
  });

  it("rejects unknown external ID providers", () => {
    expect(() =>
      validateSnapshot(
        makeSnapshot({
          externalIds: { unknown: "123" },
        }),
      ),
    ).toThrow("Invalid anime external ID");
  });

  it("rejects the same external ID assigned to two anime by one provider", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime: [
          { ...anime[0], externalIds: { myanimelist: "123" } },
          { ...anime[1], externalIds: { myanimelist: "123" } },
        ],
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Duplicate anime external ID: myanimelist:123");
  });

  it("allows the same external ID value for different providers", () => {
    const snapshot = validateSnapshot(
      makeSnapshot({
        externalIds: { myanimelist: "123", anilist: "123" },
      }),
    );

    expect(snapshot.anime[0]?.externalIds).toEqual({
      myanimelist: "123",
      anilist: "123",
    });
  });

  it("rejects invalid episode counts", () => {
    expect(() =>
      validateSnapshot(makeSnapshot({ episodes: -1 })),
    ).toThrow("Invalid anime episode count");
  });

  it("accepts null episode counts", () => {
    const snapshot = validateSnapshot(makeSnapshot({ episodes: null }));
    expect(snapshot.anime[0]?.episodes).toBeNull();
  });
});

describe("entry validation hardening", () => {
  it("rejects duplicate merged entries for the same anime", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [makeEntry(), makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Duplicate anime entry");
  });

  it("rejects invalid entry timestamps", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [{ ...makeEntry(), updatedAt: "not-a-date" }],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Invalid entry metadata");
  });

  it("rejects non-numeric entry scores", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        anime,
        entries: [{ ...makeEntry(), score: "80" }],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Score must be null or between 0 and 100");
  });
});

describe("snapshot export date validation", () => {
  it("accepts a valid export date", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 4,
      exportedAt: "2026-11-15T12:00:00.000Z",
      anime,
      entries: [makeEntry()],
      sourceEntries: [makeEntry()],
      conflictResolutions: [],
      animeRelations: [],
    });

    expect(snapshot.exportedAt).toBe("2026-11-15T12:00:00.000Z");
  });

  it("rejects an invalid export date", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        exportedAt: "not-a-date",
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Invalid snapshot export date");
  });

  it("rejects a non-string export date", () => {
    expect(() =>
      validateSnapshot({
        schemaVersion: 4,
        exportedAt: 12345,
        anime,
        entries: [makeEntry()],
        sourceEntries: [makeEntry()],
        conflictResolutions: [],
        animeRelations: [],
      }),
    ).toThrow("Invalid snapshot export date");
  });

  it("allows a missing export date for legacy compatibility", () => {
    const snapshot = validateSnapshot({
      schemaVersion: 1,
      anime,
      entries: [makeEntry()],
    });

    expect(snapshot.exportedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
