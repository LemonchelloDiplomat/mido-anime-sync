import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { BrowserAnimeRepository } from "../src/storage/browser-repository.js";
import type { AnimeIdentity, AnimeListEntry, SyncDeletionIntent } from "../src/core/types.js";

const repositories: BrowserAnimeRepository[] = [];

async function createRepository(): Promise<BrowserAnimeRepository> {
  const repository = await BrowserAnimeRepository.open("deletion-backup-" + Date.now() + "-" + Math.random());
  repositories.push(repository);
  return repository;
}

function anime(id: string): AnimeIdentity {
  return { id, titles: { english: "Example anime", synonyms: [] }, externalIds: { myanimelist: "100" } };
}

function entry(animeId: string): AnimeListEntry {
  return {
    animeId, source: "myanimelist", status: "WATCHING", progress: 4,
    score: null, favorite: false, updatedAt: "2026-11-17T10:00:00.000Z",
  };
}

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

describe("deletion intent backups", () => {
  it("exports and restores pending deletion intents with the library snapshot", async () => {
    const repo = await createRepository();
    const item = anime("deleted:1");
    const providerEntry = entry(item.id);
    await repo.saveAnime(item);
    await repo.saveSourceEntry(providerEntry);
    const intent: SyncDeletionIntent = {
      id: "delete-mal-deleted:1",
      provider: "mal",
      animeId: item.id,
      externalId: "100",
      anime: item,
      entry: providerEntry,
      createdAt: "2026-11-17T10:00:00.000Z",
    };
    await repo.deleteAnime(item.id, [intent]);

    const backup = await repo.snapshot();
    expect(backup.deletionIntents).toHaveLength(1);

    await repo.deleteDeletionIntent(intent.id);
    expect(await repo.getDeletionIntents()).toHaveLength(0);

    await repo.restoreSnapshot(backup);
    expect(await repo.getDeletionIntents()).toEqual([intent]);
    expect(await repo.getAnime(item.id)).toBeUndefined();
  });
});
