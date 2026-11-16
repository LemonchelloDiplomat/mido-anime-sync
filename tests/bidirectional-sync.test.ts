import { describe, expect, it } from "vitest";
import { createBidirectionalSyncPlan } from "../src/core/bidirectional-sync.js";
import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "../src/core/types.js";

function anime(id: string, mal = "10", al = "20"): AnimeIdentity {
  return {
    id,
    titles: { english: "Example anime", synonyms: [] },
    externalIds: { myanimelist: mal, anilist: al },
  };
}

function entry(animeId: string, source: "local" | "myanimelist" | "anilist", updatedAt: string, overrides: Partial<AnimeListEntry> = {}): AnimeListEntry {
  return {
    animeId, source, status: "WATCHING", progress: 3, score: 80, favorite: false,
    updatedAt, ...overrides,
  };
}

function remoteSnapshot(animeItems: AnimeIdentity[], entries: AnimeListEntry[]): AnimeSnapshotV4 {
  return {
    schemaVersion: 4, exportedAt: "2026-11-17T00:00:00.000Z",
    anime: animeItems, entries, sourceEntries: entries,
    conflictResolutions: [], animeRelations: [],
  };
}

describe("bidirectional sync planner", () => {
  it("sends a newer local entry to the remote service", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-17T10:00:00.000Z", { progress: 5 }) }],
      remoteSnapshot([anime("anilist:20")], [entry("anilist:20", "anilist", "2026-11-16T10:00:00.000Z")]),
      "mal",
    );
    expect(plan.remoteUpdates).toHaveLength(1);
    expect(plan.remoteUpdates[0]?.entry.progress).toBe(5);
    expect(plan.localUpdates).toHaveLength(0);
  });

  it("imports a newer remote entry into the local library", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-16T10:00:00.000Z") }],
      remoteSnapshot([anime("mal:10")], [entry("mal:10", "myanimelist", "2026-11-17T10:00:00.000Z", { progress: 7 })]),
      "mal",
    );
    expect(plan.localUpdates).toHaveLength(1);
    expect(plan.localUpdates[0]?.entry.progress).toBe(7);
    expect(plan.remoteUpdates).toHaveLength(0);
  });

  it("creates missing remote entries from local records", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-17T10:00:00.000Z") }],
      remoteSnapshot([], []),
      "mal",
    );
    expect(plan.remoteCreates).toHaveLength(1);
    expect(plan.remoteCreates[0]?.externalId).toBe("10");
  });

  it("imports remote-only entries into the local library", () => {
    const remoteAnime = anime("mal:10");
    const plan = createBidirectionalSyncPlan([], remoteSnapshot([remoteAnime], [entry(remoteAnime.id, "myanimelist", "2026-11-17T10:00:00.000Z")]), "mal");
    expect(plan.localCreates).toHaveLength(1);
    expect(plan.localCreates[0]?.anime.id).toBe("mal:10");
  });

  it("blocks the whole entry when timestamps are equal and values differ", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-17T10:00:00.000Z", { progress: 5 }) }],
      remoteSnapshot([anime("mal:10")], [entry("mal:10", "myanimelist", "2026-11-17T10:00:00.000Z", { progress: 7 })]),
      "mal",
    );
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.remoteUpdates).toHaveLength(0);
    expect(plan.localUpdates).toHaveLength(0);
  });

  it("blocks the whole entry when either timestamp is invalid", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "not-a-date", { progress: 5 }) }],
      remoteSnapshot([anime("mal:10")], [entry("mal:10", "myanimelist", "2026-11-17T10:00:00.000Z")]),
      "mal",
    );
    expect(plan.conflicts[0]?.reason).toBe("unknown_order");
    expect(plan.remoteUpdates).toHaveLength(0);
  });

  it("does not sync AniList favorites to MAL", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-17T10:00:00.000Z", { favorite: true }) }],
      remoteSnapshot([anime("mal:10")], [entry("mal:10", "myanimelist", "2026-11-17T10:00:00.000Z", { favorite: false })]),
      "mal",
    );
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("syncs AniList favorites as a supported field", () => {
    const localAnime = anime("local:10");
    const plan = createBidirectionalSyncPlan(
      [{ anime: localAnime, entry: entry(localAnime.id, "local", "2026-11-17T10:00:00.000Z", { favorite: true }) }],
      remoteSnapshot([anime("anilist:20")], [entry("anilist:20", "anilist", "2026-11-16T10:00:00.000Z")]),
      "anilist",
    );
    expect(plan.remoteUpdates[0]?.entry.favorite).toBe(true);
  });

  it("rejects duplicate external IDs instead of choosing an arbitrary match", () => {
    const first = anime("local:1");
    const second = anime("local:2");
    expect(() => createBidirectionalSyncPlan(
      [{ anime: first, entry: entry(first.id, "local", "2026-11-17T10:00:00.000Z") }, { anime: second, entry: entry(second.id, "local", "2026-11-17T10:00:00.000Z") }],
      remoteSnapshot([], []),
      "mal",
    )).toThrow(/несколько аниме имеют один внешний ID/);
  });
});
