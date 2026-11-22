import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import { BrowserAnimeRepository, LIBRARY_DATABASE_SCHEMA_VERSION } from "../src/storage/browser-repository.js";

const repositories: BrowserAnimeRepository[] = [];

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

describe("IndexedDB schema migrations", () => {
  it("upgrades a populated v7 library to v8 without changing user data", async () => {
    const name = `anime-sync-v7-upgrade-${Date.now()}-${Math.random()}`;
    const anime = {
      id: "mal:100",
      titles: { english: "Migration Test", synonyms: [] },
      externalIds: { myanimelist: "100" },
      episodes: 12,
    };
    const entry = {
      animeId: "mal:100",
      source: "myanimelist",
      status: "WATCHING",
      progress: 7,
      score: 85,
      favorite: true,
      updatedAt: "2026-11-22T12:00:00.000Z",
    };

    const legacyDb = await openDB(name, 7, {
      upgrade(database) {
        database.createObjectStore("anime", { keyPath: "id" });
        database.createObjectStore("entries", { keyPath: "animeId" });
        database.createObjectStore("sourceEntries", { keyPath: ["animeId", "source"] });
        database.createObjectStore("conflictResolutions", { keyPath: "animeId" });
        database.createObjectStore("animeRelations", { keyPath: "id" });
        const operations = database.createObjectStore("syncOperations", { keyPath: "id" });
        operations.createIndex("by-session", "sessionId");
        operations.createIndex("by-status", "status");
        operations.createIndex("by-provider", "provider");
        const sessions = database.createObjectStore("syncSessions", { keyPath: "sessionId" });
        sessions.createIndex("by-started-at", "startedAt");
        sessions.createIndex("by-provider", "provider");
        sessions.createIndex("by-status", "status");
        const deletions = database.createObjectStore("deletionIntents", { keyPath: "id" });
        deletions.createIndex("by-provider", "provider");
        deletions.createIndex("by-created-at", "createdAt");
      },
    });
    await Promise.all([
      legacyDb.put("anime", anime),
      legacyDb.put("entries", entry),
      legacyDb.put("sourceEntries", entry),
    ]);
    legacyDb.close();

    const repository = await BrowserAnimeRepository.open(name);
    repositories.push(repository);

    expect(await repository.getAnime("mal:100")).toEqual(anime);
    expect(await repository.getEntry("mal:100")).toMatchObject({
      status: "WATCHING",
      progress: 7,
      score: 85,
      favorite: true,
    });
    expect(await repository.getSourceEntries("mal:100")).toHaveLength(1);

    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    const upgradedDb = await openDB(name, LIBRARY_DATABASE_SCHEMA_VERSION);
    expect(upgradedDb.objectStoreNames.contains("appMetadata")).toBe(true);
    expect(await upgradedDb.get("appMetadata", "schemaVersion")).toMatchObject({
      key: "schemaVersion",
      value: LIBRARY_DATABASE_SCHEMA_VERSION,
    });
    upgradedDb.close();
  });
});
