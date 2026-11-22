import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  createMigrationBackupIfNeeded,
  getMigrationBackupDatabaseName,
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
    expect(persisted?.stores.find((store) => store.name === "syncOperations")?.records)
      .toEqual([{ id: "operation-1", status: "pending" }]);
    expect(persisted?.stores.find((store) => store.name === "syncSessions")?.records)
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
