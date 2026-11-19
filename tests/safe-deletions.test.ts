import { describe, expect, it } from "vitest";
import { detectRemoteDeletions } from "../src/core/safe-deletions.js";
import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "../src/core/types.js";

function anime(id: string, mal = "10", al = "20"): AnimeIdentity {
  return {
    id,
    titles: { english: "Example anime", synonyms: [] },
    externalIds: { myanimelist: mal, anilist: al },
  };
}

function entry(
  animeId: string,
  source: "local" | "myanimelist" | "anilist",
  overrides: Partial<AnimeListEntry> = {},
): AnimeListEntry {
  return {
    animeId,
    source,
    status: "WATCHING",
    progress: 3,
    score: 80,
    favorite: false,
    updatedAt: "2026-11-15T10:00:00.000Z",
    ...overrides,
  };
}

function snapshot(animeItems: AnimeIdentity[], entries: AnimeListEntry[]): AnimeSnapshotV4 {
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-17T00:00:00.000Z",
    anime: animeItems,
    entries,
    sourceEntries: entries,
    conflictResolutions: [],
    animeRelations: [],
  };
}

function nonEmptyRemoteSnapshot(provider: "mal" | "anilist"): AnimeSnapshotV4 {
  const remoteAnime = anime("remote:unrelated", "999", "888");
  const source = provider === "mal" ? "myanimelist" : "anilist";
  return snapshot([remoteAnime], [entry(remoteAnime.id, source)]);
}

describe("safe remote deletion detection", () => {
  it("detects a remote deletion when the provider entry still matches its baseline", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "myanimelist");
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: baseline, baseline }],
      nonEmptyRemoteSnapshot("mal"),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(1);
    expect(result.localRemovals[0]).toMatchObject({
      animeId: localAnime.id,
      externalId: "10",
      title: "Example anime",
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.blockedReason).toBeNull();
  });

  it("does not infer a remote deletion when the remote entry is still present", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "myanimelist");
    const remoteAnime = anime("mal:10");
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: baseline, baseline }],
      snapshot([remoteAnime], [entry(remoteAnime.id, "myanimelist")]),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("turns remote deletion into a conflict when the local provider entry changed", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "myanimelist", { progress: 3 });
    const current = entry(localAnime.id, "myanimelist", { progress: 8 });
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: current, baseline }],
      nonEmptyRemoteSnapshot("mal"),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      animeId: localAnime.id,
      externalId: "10",
      baseline: { progress: 3 },
      localEntry: { progress: 8 },
    });
  });

  it("detects a local edit even when the stored provider entry still equals the baseline", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "myanimelist", { progress: 3 });
    const localAggregate = entry(localAnime.id, "local", { progress: 8 });
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: localAggregate, baseline }],
      nonEmptyRemoteSnapshot("mal"),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.localEntry.progress).toBe(8);
  });

  it("blocks an empty remote response when the baseline contains entries", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "anilist");
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: baseline, baseline }],
      snapshot([], []),
      "anilist",
    );

    expect(result.localRemovals).toHaveLength(0);
    expect(result.blockedReason).toMatch(/пустой список/i);
  });

  it("uses MAL score precision when comparing against the baseline", () => {
    const localAnime = anime("local:10");
    const baseline = entry(localAnime.id, "myanimelist", { score: 80 });
    const current = entry(localAnime.id, "myanimelist", { score: 84 });
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: current, baseline }],
      nonEmptyRemoteSnapshot("mal"),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it("requires an extra confirmation for a large or substantial deletion batch", () => {
    const items = Array.from({ length: 10 }, (_, index) => {
      const item = anime("local:" + index, String(100 + index), String(200 + index));
      const baseline = entry(item.id, "anilist");
      return { anime: item, entry: baseline, baseline };
    });
    const result = detectRemoteDeletions(items, nonEmptyRemoteSnapshot("anilist"), "anilist");

    expect(result.localRemovals).toHaveLength(10);
    expect(result.requiresBulkConfirmation).toBe(true);
  });

  it("does not detect deletions without a stored baseline", () => {
    const localAnime = anime("local:10");
    const current = entry(localAnime.id, "local");
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: current }],
      snapshot([], []),
      "mal",
    );

    expect(result.localRemovals).toHaveLength(0);
    expect(result.blockedReason).toBeNull();
  });
});


describe("Shikimori safe deletion detection", () => {
  it("uses the Shikimori identity and ten-point score precision", () => {
    const localAnime: AnimeIdentity = {
      id: "local:41",
      titles: { english: "Example anime", synonyms: [] },
      externalIds: { shikimori: "41" },
    };
    const baseline: AnimeListEntry = {
      animeId: localAnime.id,
      source: "shikimori",
      status: "WATCHING",
      progress: 4,
      score: 80,
      favorite: false,
      updatedAt: "2026-11-15T10:00:00.000Z",
    };
    const current = { ...baseline, score: 84 };
    const remoteAnime: AnimeIdentity = {
      id: "shikimori:999",
      titles: { english: "Other anime", synonyms: [] },
      externalIds: { shikimori: "999" },
    };
    const remoteEntry: AnimeListEntry = {
      ...baseline,
      animeId: remoteAnime.id,
      updatedAt: "2026-11-17T10:00:00.000Z",
    };
    const result = detectRemoteDeletions(
      [{ anime: localAnime, entry: current, baseline }],
      snapshot([remoteAnime], [remoteEntry]),
      "shikimori",
    );

    expect(result.localRemovals).toHaveLength(1);
    expect(result.localRemovals[0]?.externalId).toBe("41");
    expect(result.conflicts).toHaveLength(0);
  });
});
