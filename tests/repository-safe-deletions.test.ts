import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { BrowserAnimeRepository } from "../src/storage/browser-repository.js";
import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4, SyncDeletionIntent } from "../src/core/types.js";

const repositories: BrowserAnimeRepository[] = [];

async function createRepository(): Promise<BrowserAnimeRepository> {
  const repository = await BrowserAnimeRepository.open("safe-deletion-" + Date.now() + "-" + Math.random());
  repositories.push(repository);
  return repository;
}

function anime(id: string): AnimeIdentity {
  return {
    id,
    titles: { english: "Example anime", synonyms: [] },
    externalIds: { myanimelist: "100", anilist: "200" },
  };
}

function entry(animeId: string, source: "myanimelist" | "anilist", progress: number): AnimeListEntry {
  return {
    animeId,
    source,
    status: "WATCHING",
    progress,
    score: null,
    favorite: false,
    updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

function intent(animeValue: AnimeIdentity, entryValue: AnimeListEntry, provider: "mal" | "anilist"): SyncDeletionIntent {
  return {
    id: "delete-" + provider + "-" + animeValue.id,
    provider,
    animeId: animeValue.id,
    externalId: provider === "mal" ? "100" : "200",
    anime: animeValue,
    entry: entryValue,
    createdAt: "2026-11-17T10:00:00.000Z",
  };
}

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

describe("safe deletion persistence", () => {
  it("stores remote deletion intents atomically with a local anime deletion", async () => {
    const repo = await createRepository();
    const item = anime("local:1");
    const malEntry = entry(item.id, "myanimelist", 4);
    const anilistEntry = entry(item.id, "anilist", 4);
    await repo.saveAnime(item);
    await repo.saveSourceEntries([malEntry, anilistEntry]);

    await repo.deleteAnime(item.id, [
      intent(item, malEntry, "mal"),
      intent(item, anilistEntry, "anilist"),
    ]);

    expect(await repo.getAnime(item.id)).toBeUndefined();
    expect(await repo.getDeletionIntents()).toHaveLength(2);
    expect(await repo.getDeletionIntents("mal")).toHaveLength(1);
    expect(await repo.getDeletionIntents("anilist")).toHaveLength(1);
  });

  it("removes only one provider entry and rebuilds the aggregate entry", async () => {
    const repo = await createRepository();
    const item = anime("local:2");
    const malEntry = entry(item.id, "myanimelist", 4);
    const anilistEntry = entry(item.id, "anilist", 7);
    await repo.saveAnime(item);
    await repo.saveSourceEntries([malEntry, anilistEntry]);

    await repo.deleteSourceEntry(item.id, "myanimelist");

    expect(await repo.getSourceEntries(item.id)).toEqual([anilistEntry]);
    expect(await repo.getEntry(item.id)).toMatchObject({
      animeId: item.id,
      source: "anilist",
      progress: 7,
    });
    expect(await repo.getAnime(item.id)).toMatchObject({ id: item.id });
  });

  it("clears pending deletion intents when a full backup is restored", async () => {
    const repo = await createRepository();
    const item = anime("local:3");
    const malEntry = entry(item.id, "myanimelist", 2);
    await repo.saveAnime(item);
    await repo.saveSourceEntry(malEntry);
    await repo.deleteAnime(item.id, [intent(item, malEntry, "mal")]);

    const snapshot: AnimeSnapshotV4 = {
      schemaVersion: 4,
      exportedAt: "2026-11-17T10:00:00.000Z",
      anime: [item],
      entries: [malEntry],
      sourceEntries: [malEntry],
      conflictResolutions: [],
      animeRelations: [],
    };
    await repo.restoreSnapshot(snapshot);

    expect(await repo.getDeletionIntents()).toEqual([]);
    expect(await repo.getAnime(item.id)).toMatchObject({ id: item.id });
  });
});
