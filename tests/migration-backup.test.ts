import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  createMigrationBackupIfNeeded,
  getMigrationBackupDatabaseName,
  restoreMigrationBackup,
} from "../src/storage/migration-backup.js";

const databaseNames: string[] = [];

afterEach(async () => {
  for (const name of databaseNames.splice(0)) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
});

describe("pre-migration IndexedDB backups", () => {
  it("backs up every object store and verifies the persisted record counts", async () => {
    const name = `migration-backup-${Date.now()}-${Math.random()}`;
    const backupName = getMigrationBackupDatabaseName(name);
    databaseNames.push(name, backupName);

    const db = await openDB(name, 7, {
      upgrade(database) {
        for (const storeName of [
          "anime",
          "entries",
          "sourceEntries",
          "conflictResolutions",
          "animeRelations",
          "syncOperations",
          "syncSessions",
          "deletionIntents",
          "appMetadata",
        ]) {
          database.createObjectStore(storeName, { keyPath: "id" });
        }
      },
    });
    await db.put("anime", { id: "anime-1", title: "Local record" });
    await db.put("syncOperations", { id: "operation-1", status: "pending" });
    await db.put("syncSessions", { id: "session-1", status: "running" });
    await db.put("deletionIntents", { id: "delete-1", externalId: "123" });
    db.close();

    const backup = await createMigrationBackupIfNeeded(name, 8);

    expect(backup).not.toBeNull();
    expect(backup?.sourceVersion).toBe(7);
    expect(backup?.targetVersion).toBe(8);
    expect(backup?.stores.map((store) => store.name)).toEqual([
      "anime",
      "animeRelations",
      "appMetadata",
      "conflictResolutions",
      "deletionIntents",
      "entries",
      "sourceEntries",
      "syncOperations",
      "syncSessions",
    ]);
    expect(backup?.integrity.totalRecordCount).toBe(4);

    const backupDb = await openDB(backupName, 1);
    const persisted = await backupDb.get("backups", backup!.id);
    expect(persisted?.stores.find((store: { name: string }) => store.name === "syncOperations")?.records)
      .toEqual([{ id: "operation-1", status: "pending" }]);
    expect(persisted?.stores.find((store: { name: string }) => store.name === "syncSessions")?.records)
      .toEqual([{ id: "session-1", status: "running" }]);
    backupDb.close();
  });

  it("does not create a backup for a database that does not exist", async () => {
    const name = `missing-migration-db-${Date.now()}-${Math.random()}`;
    const backup = await createMigrationBackupIfNeeded(name, 8);
    expect(backup).toBeNull();
    expect(await new Promise<boolean>((resolve) => {
      const request = indexedDB.databases();
      request.then((databases) => resolve(databases.some((database) => database.name === name)));
    })).toBe(false);
  });
});


  it("restores a backup atomically and cancels every interrupted sync session", async () => {
    const name = `migration-restore-${Date.now()}-${Math.random()}`;
    const backupName = getMigrationBackupDatabaseName(name);
    databaseNames.push(name, backupName);

    const db = await openDB(name, 7, {
      upgrade(database) {
        database.createObjectStore("anime", { keyPath: "id" });
        const operations = database.createObjectStore("syncOperations", { keyPath: "id" });
        operations.createIndex("by-session", "sessionId");
        const sessions = database.createObjectStore("syncSessions", { keyPath: "sessionId" });
        sessions.createIndex("by-status", "status");
      },
    });
    await db.put("anime", { id: "anime-1", title: "Original title" });
    await db.put("syncOperations", {
      id: "operation-1",
      sessionId: "session-1",
      status: "pending",
      updatedAt: "2026-11-22T12:00:00.000Z",
    });
    await db.put("syncSessions", {
      sessionId: "session-1",
      status: "running",
      pendingCount: 1,
      operationCount: 1,
    });
    await db.put("syncSessions", {
      sessionId: "session-without-operations",
      status: "running",
      pendingCount: 0,
      operationCount: 0,
    });
    db.close();

    const backup = await createMigrationBackupIfNeeded(name, 8);
    expect(backup).not.toBeNull();

    const changedDb = await openDB(name, 7);
    await changedDb.put("anime", { id: "anime-1", title: "Changed after backup" });
    await changedDb.put("anime", { id: "anime-2", title: "Added after backup" });
    await changedDb.put("syncOperations", {
      id: "operation-1",
      sessionId: "session-1",
      status: "in_progress",
      updatedAt: "2026-11-22T12:05:00.000Z",
    });
    changedDb.close();

    const result = await restoreMigrationBackup(name, backup!.id);
    expect(result.restoredRecordCount).toBe(4);
    expect(result.safetyBackupId).toBeTruthy();

    const restoredDb = await openDB(name, 7);
    expect(await restoredDb.getAll("anime")).toEqual([
      { id: "anime-1", title: "Original title" },
    ]);
    expect(await restoredDb.get("syncOperations", "operation-1")).toMatchObject({
      status: "cancelled",
      sessionId: "session-1",
    });
    expect(await restoredDb.get("syncSessions", "session-1")).toMatchObject({
      status: "cancelled",
      pendingCount: 0,
    });
    expect(await restoredDb.get("syncSessions", "session-without-operations")).toMatchObject({
      status: "cancelled",
      pendingCount: 0,
    });
    restoredDb.close();

    const backupDb = await openDB(backupName, 1);
    expect(await backupDb.count("backups")).toBe(2);
    backupDb.close();
  });

  it("refuses to restore when the current schema contains an unknown newer store", async () => {
    const name = `migration-restore-incompatible-${Date.now()}-${Math.random()}`;
    const backupName = getMigrationBackupDatabaseName(name);
    databaseNames.push(name, backupName);

    const legacy = await openDB(name, 7, {
      upgrade(database) {
        database.createObjectStore("anime", { keyPath: "id" });
      },
    });
    await legacy.put("anime", { id: "anime-1", title: "Keep me" });
    legacy.close();

    const backup = await createMigrationBackupIfNeeded(name, 8);
    expect(backup).not.toBeNull();

    const upgraded = await openDB(name, 8, {
      upgrade(database) {
        database.createObjectStore("futureStore", { keyPath: "id" });
      },
    });
    await upgraded.put("futureStore", { id: "future-1", value: "must survive" });
    upgraded.close();

    await expect(restoreMigrationBackup(name, backup!.id)).rejects.toThrow(
      "Резервная копия не содержит новое хранилище futureStore",
    );

    const current = await openDB(name, 8);
    expect(await current.get("anime", "anime-1")).toEqual({
      id: "anime-1",
      title: "Keep me",
    });
    expect(await current.get("futureStore", "future-1")).toEqual({
      id: "future-1",
      value: "must survive",
    });
    current.close();
  });
