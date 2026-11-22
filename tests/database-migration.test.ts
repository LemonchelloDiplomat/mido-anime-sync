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
      legacyDb.put("syncOperations", {
        id: "migration-operation",
        sessionId: "migration-session",
        provider: "mal",
        direction: "remote",
        kind: "update",
        animeId: "mal:100",
        entry,
        status: "pending",
        attempts: 1,
        createdAt: "2026-11-22T12:00:00.000Z",
        updatedAt: "2026-11-22T12:00:00.000Z",
      }),
      legacyDb.put("syncSessions", {
        sessionId: "migration-session",
        provider: "mal",
        status: "running",
        startedAt: "2026-11-22T12:00:00.000Z",
        operationCount: 1,
        succeededCount: 0,
        failedCount: 0,
        pendingCount: 1,
        unchangedCount: 0,
        conflictCount: 0,
        recoveredCount: 0,
      }),
      legacyDb.put("deletionIntents", {
        id: "migration-deletion",
        provider: "mal",
        animeId: "mal:100",
        externalId: "100",
        anime,
        entry,
        createdAt: "2026-11-22T12:00:00.000Z",
      }),
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

    // The pre-upgrade backup includes operational stores as well as library
    // records, so interrupted sync sessions and pending deletion intents survive.
    const backupDb = await openDB(`${name}__migration_backups`, 1);
    const backups = await backupDb.getAll("backups");
    expect(backups).toHaveLength(1);
    expect(backups[0]?.integrity.totalRecordCount).toBe(6);
    expect(backups[0]?.stores.find((store: { name: string; records: unknown[]; recordCount: number }) => store.name === "syncOperations")?.records)
      .toMatchObject([{ id: "migration-operation", status: "pending" }]);
    expect(backups[0]?.stores.find((store: { name: string; records: unknown[]; recordCount: number }) => store.name === "syncSessions")?.records)
      .toMatchObject([{ sessionId: "migration-session", status: "running" }]);
    expect(backups[0]?.stores.find((store: { name: string; records: unknown[]; recordCount: number }) => store.name === "deletionIntents")?.records)
      .toMatchObject([{ id: "migration-deletion", externalId: "100" }]);
    backupDb.close();

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

  it("closes stale app connections so an IndexedDB upgrade is not blocked", async () => {
    const name = `anime-sync-blocked-upgrade-${Date.now()}-${Math.random()}`;
    let blockingCalled = false;
    const legacyDb = await openDB(name, 7, {
      upgrade(database) {
        database.createObjectStore("anime", { keyPath: "id" });
      },
      blocking() {
        blockingCalled = true;
        legacyDb.close();
      },
    });
    await legacyDb.put("anime", { id: "anime-1", titles: { english: "Keep me" } });

    const repository = await BrowserAnimeRepository.open(name);
    repositories.push(repository);

    expect(blockingCalled).toBe(true);
    expect(await repository.getAnime("anime-1")).toMatchObject({
      id: "anime-1",
      titles: { english: "Keep me" },
    });
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
  });
});
