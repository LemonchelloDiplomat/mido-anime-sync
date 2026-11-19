import type { SyncOperation, SyncSession } from "./types.js";

export interface InterruptedSyncSessionDependencies {
  updateSyncSession: (
    sessionId: string,
    changes: Partial<Omit<SyncSession, "sessionId" | "provider" | "startedAt">>,
  ) => Promise<void>;
}

/**
 * Finalizes abandoned sessions after the caller has exclusive ownership of
 * account synchronization and has reconciled every unfinished journal entry.
 *
 * Sessions with pending operations are deliberately left untouched: the
 * caller must not turn an unresolved write into a false success or failure.
 */
export async function reconcileInterruptedSyncSessions(
  currentSessionId: string,
  sessions: SyncSession[],
  operations: SyncOperation[],
  dependencies: InterruptedSyncSessionDependencies,
  finishedAt = new Date().toISOString(),
): Promise<number> {
  let reconciledSessions = 0;

  for (const session of sessions) {
    if (
      session.status !== "running" ||
      session.sessionId === currentSessionId
    ) {
      continue;
    }

    const sessionOperations = operations.filter(
      (operation) => operation.sessionId === session.sessionId,
    );
    const succeededCount = sessionOperations.filter(
      (operation) => operation.status === "succeeded",
    ).length;
    const failedOperations = sessionOperations.filter(
      (operation) => operation.status === "failed",
    );
    const cancelledCount = sessionOperations.filter(
      (operation) => operation.status === "cancelled",
    ).length;
    const pendingCount = sessionOperations.filter(
      (operation) =>
        operation.status === "pending" || operation.status === "in_progress",
    ).length;

    // Do not finalize while any journal entry is still unresolved.
    if (pendingCount > 0) continue;

    const hasNoJournal = sessionOperations.length === 0;
    const status = hasNoJournal || failedOperations.length > 0
      ? "failed"
      : cancelledCount === sessionOperations.length
        ? "cancelled"
        : cancelledCount > 0
          ? "cancelled"
          : "succeeded";

    const error = hasNoJournal
      ? "Сессия прервана до сохранения журнала операций. Результат синхронизации не подтверждён."
      : failedOperations.length > 0
        ? failedOperations
            .map((operation) => operation.error)
            .filter((message): message is string => Boolean(message))
            .slice(0, 5)
            .join("; ") || "Сессия прервана с ошибками операций."
        : undefined;

    await dependencies.updateSyncSession(session.sessionId, {
      status,
      finishedAt,
      operationCount: sessionOperations.length,
      succeededCount,
      failedCount: failedOperations.length,
      pendingCount: 0,
      ...(error ? { error } : {}),
    });
    reconciledSessions += 1;
  }

  return reconciledSessions;
}
