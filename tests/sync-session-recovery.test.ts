import { describe, expect, it, vi } from "vitest";
import type { SyncOperation, SyncSession } from "../src/core/types.js";
import { reconcileInterruptedSyncSessions } from "../src/core/sync-session-recovery.js";

function session(
  sessionId: string,
  overrides: Partial<SyncSession> = {},
): SyncSession {
  return {
    sessionId,
    provider: "mal",
    status: "running",
    startedAt: "2026-11-19T10:00:00.000Z",
    operationCount: 0,
    succeededCount: 0,
    failedCount: 0,
    pendingCount: 0,
    unchangedCount: 0,
    conflictCount: 0,
    recoveredCount: 0,
    ...overrides,
  };
}

function operation(
  sessionId: string,
  status: SyncOperation["status"],
  overrides: Partial<SyncOperation> = {},
): SyncOperation {
  return {
    id: `${sessionId}-operation-1`,
    sessionId,
    provider: "mal",
    direction: "remote",
    kind: "update",
    animeId: "anime-1",
    externalId: "100",
    entry: {
      animeId: "anime-1",
      source: "myanimelist",
      status: "WATCHING",
      progress: 2,
      score: null,
      favorite: false,
      updatedAt: "2026-11-19T10:00:00.000Z",
    },
    status,
    attempts: 1,
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:01.000Z",
    ...overrides,
  };
}

describe("interrupted sync session recovery", () => {
  it("marks a session interrupted when the app closed before the operation journal was saved", async () => {
    const updateSyncSession = vi.fn(async () => undefined);
    const result = await reconcileInterruptedSyncSessions(
      "current-session",
      [session("abandoned-session")],
      [],
      { updateSyncSession },
      "2026-11-19T12:00:00.000Z",
    );

    expect(result).toBe(1);
    expect(updateSyncSession).toHaveBeenCalledWith("abandoned-session", {
      status: "failed",
      finishedAt: "2026-11-19T12:00:00.000Z",
      operationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 0,
      error: expect.stringContaining("до сохранения журнала"),
    });
  });

  it("marks a session succeeded when every journal operation was reconciled successfully", async () => {
    const updateSyncSession = vi.fn(async () => undefined);
    const result = await reconcileInterruptedSyncSessions(
      "current-session",
      [session("completed-session")],
      [
        operation("completed-session", "succeeded"),
        operation("completed-session", "succeeded", { id: "completed-session-operation-2" }),
      ],
      { updateSyncSession },
    );

    expect(result).toBe(1);
    expect(updateSyncSession).toHaveBeenCalledWith("completed-session", expect.objectContaining({
      status: "succeeded",
      operationCount: 2,
      succeededCount: 2,
      failedCount: 0,
      pendingCount: 0,
    }));
  });

  it("marks a session failed when a reconciled operation failed", async () => {
    const updateSyncSession = vi.fn(async () => undefined);
    await reconcileInterruptedSyncSessions(
      "current-session",
      [session("failed-session")],
      [operation("failed-session", "failed", { error: "provider rejected write" })],
      { updateSyncSession },
    );

    expect(updateSyncSession).toHaveBeenCalledWith("failed-session", expect.objectContaining({
      status: "failed",
      failedCount: 1,
      error: "provider rejected write",
    }));
  });

  it("does not touch the current session or sessions with unresolved operations", async () => {
    const updateSyncSession = vi.fn(async () => undefined);
    await reconcileInterruptedSyncSessions(
      "current-session",
      [
        session("current-session"),
        session("anilist-session", { provider: "anilist" }),
        session("unresolved-session"),
      ],
      [operation("unresolved-session", "in_progress")],
      { updateSyncSession },
    );

    expect(updateSyncSession).toHaveBeenCalledTimes(1);
    expect(updateSyncSession).toHaveBeenCalledWith("anilist-session", expect.objectContaining({ status: "failed" }));
  });
});
