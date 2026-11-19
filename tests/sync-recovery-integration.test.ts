import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileUnfinishedSyncOperations,
} from "../src/core/sync-recovery.js";
import {
  resolvePendingRemoteDeletionIntents,
} from "../src/core/remote-deletion.js";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  SyncDeletionIntent,
  SyncOperation,
  SyncSession,
} from "../src/core/types.js";
import { BrowserAnimeRepository } from "../src/storage/browser-repository.js";

const repositories: BrowserAnimeRepository[] = [];

async function openRepository(name: string): Promise<BrowserAnimeRepository> {
  const repository = await BrowserAnimeRepository.open(name);
  repositories.push(repository);
  return repository;
}

function databaseName(): string {
  return `sync-recovery-integration-${Date.now()}-${Math.random()}`;
}

function anime(): AnimeIdentity {
  return {
    id: "local:100",
    titles: { english: "Recovery test anime", synonyms: [] },
    externalIds: { myanimelist: "100", anilist: "200" },
  };
}

function entry(animeId = "local:100"): AnimeListEntry {
  return {
    animeId,
    source: "myanimelist",
    status: "WATCHING",
    progress: 4,
    score: 80,
    favorite: false,
    updatedAt: "2026-11-19T10:00:00.000Z",
  };
}

function operation(
  direction: "local" | "remote",
  kind: "create" | "update" | "delete" = "delete",
): SyncOperation {
  return {
    id: `session-1-${direction}-delete-0`,
    sessionId: "session-1",
    provider: "mal",
    direction,
    kind,
    animeId: "local:100",
    ...(direction === "remote" ? { externalId: "100" } : {}),
    entry: entry(),
    ...(direction === "remote" ? { anime: anime() } : {}),
    status: "in_progress",
    attempts: 1,
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:01.000Z",
  };
}

function session(): SyncSession {
  return {
    sessionId: "session-1",
    provider: "mal",
    status: "running",
    startedAt: "2026-11-19T10:00:00.000Z",
    operationCount: 1,
    succeededCount: 0,
    failedCount: 0,
    pendingCount: 1,
    unchangedCount: 0,
    conflictCount: 0,
    recoveredCount: 0,
  };
}

function emptyRemoteSnapshot(): AnimeSnapshotV4 {
  return {
    schemaVersion: 4,
    exportedAt: "2026-11-19T10:01:00.000Z",
    anime: [],
    entries: [],
    sourceEntries: [],
    conflictResolutions: [],
    animeRelations: [],
  };
}

function deletionIntent(): SyncDeletionIntent {
  const item = anime();
  return {
    id: "delete-mal-local:100",
    provider: "mal",
    animeId: item.id,
    externalId: "100",
    anime: item,
    entry: entry(item.id),
    createdAt: "2026-11-19T10:00:00.000Z",
  };
}

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

describe("sync recovery with persisted IndexedDB state", () => {
  it("recovers a local delete after closing and reopening the database", async () => {
    const name = databaseName();
    const firstRepository = await openRepository(name);
    const item = anime();
    const pendingOperation = operation("local");

    await firstRepository.saveAnime(item);
    await firstRepository.saveSourceEntry(entry(item.id));
    await firstRepository.saveSyncSession(session());
    await firstRepository.saveSyncOperations([pendingOperation]);
    await firstRepository.deleteSourceEntry(item.id, "myanimelist");

    firstRepository.close();

    const reopenedRepository = await openRepository(name);
    expect(await reopenedRepository.getSourceEntries(item.id)).toEqual([]);
    expect(await reopenedRepository.getSyncSessions()).toEqual([session()]);

    const unfinished = await reopenedRepository.getUnfinishedSyncOperations("mal");
    const result = await reconcileUnfinishedSyncOperations(
      unfinished,
      "mal",
      emptyRemoteSnapshot(),
      {
        getSourceEntries: (animeId) => reopenedRepository.getSourceEntries(animeId),
        updateSyncOperation: (id, update) => reopenedRepository.updateSyncOperation(id, update),
      },
    );

    expect(result.recoveredOperations).toBe(1);
    expect(await reopenedRepository.getUnfinishedSyncOperations("mal")).toEqual([]);
    expect(await reopenedRepository.getSyncOperations()).toMatchObject([
      { id: pendingOperation.id, status: "succeeded", attempts: 1 },
    ]);
  });

  it("does not recover a local delete when the source entry survived the restart", async () => {
    const name = databaseName();
    const firstRepository = await openRepository(name);
    const item = anime();
    const pendingOperation = operation("local");

    await firstRepository.saveAnime(item);
    await firstRepository.saveSourceEntry(entry(item.id));
    await firstRepository.saveSyncOperations([pendingOperation]);
    firstRepository.close();

    const reopenedRepository = await openRepository(name);
    const unfinished = await reopenedRepository.getUnfinishedSyncOperations("mal");
    const result = await reconcileUnfinishedSyncOperations(
      unfinished,
      "mal",
      emptyRemoteSnapshot(),
      {
        getSourceEntries: (animeId) => reopenedRepository.getSourceEntries(animeId),
        updateSyncOperation: (id, update) => reopenedRepository.updateSyncOperation(id, update),
      },
    );

    expect(result.recoveredOperations).toBe(0);
    expect(await reopenedRepository.getSyncOperations()).toMatchObject([
      {
        id: pendingOperation.id,
        status: "failed",
        error: expect.stringContaining("текущее состояние не совпадает"),
      },
    ]);
  });

  it("recovers a completed remote delete and clears its persisted intent after restart", async () => {
    const name = databaseName();
    const firstRepository = await openRepository(name);
    const item = anime();
    const pendingOperation = operation("remote");
    const intent = deletionIntent();

    await firstRepository.saveAnime(item);
    await firstRepository.saveSourceEntry(entry(item.id));
    await firstRepository.deleteAnime(item.id, [intent]);
    await firstRepository.saveSyncOperations([pendingOperation]);
    firstRepository.close();

    const reopenedRepository = await openRepository(name);
    expect(await reopenedRepository.getDeletionIntents("mal")).toEqual([intent]);

    const remoteSnapshot = emptyRemoteSnapshot();
    const unfinished = await reopenedRepository.getUnfinishedSyncOperations("mal");
    const recovery = await reconcileUnfinishedSyncOperations(
      unfinished,
      "mal",
      remoteSnapshot,
      {
        getSourceEntries: (animeId) => reopenedRepository.getSourceEntries(animeId),
        updateSyncOperation: (id, update) => reopenedRepository.updateSyncOperation(id, update),
      },
    );

    const candidates = await resolvePendingRemoteDeletionIntents(
      await reopenedRepository.getDeletionIntents("mal"),
      remoteSnapshot,
      "mal",
      (id) => reopenedRepository.deleteDeletionIntent(id),
    );

    expect(recovery.recoveredOperations).toBe(1);
    expect(candidates).toEqual([]);
    expect(await reopenedRepository.getDeletionIntents()).toEqual([]);
    expect(await reopenedRepository.getSyncOperations()).toMatchObject([
      { id: pendingOperation.id, status: "succeeded" },
    ]);
  });
});
