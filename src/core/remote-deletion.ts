import type {
  AnimeListEntry,
  AnimeSnapshot,
  SyncDeletionIntent,
  SyncOperation,
} from "./types.js";

export interface RemoteDeletionCandidate {
  intent: SyncDeletionIntent;
  entry: AnimeListEntry;
  entryId?: number;
}

export async function resolvePendingRemoteDeletionIntents(
  intents: SyncDeletionIntent[],
  remoteSnapshot: AnimeSnapshot,
  provider: "mal" | "anilist",
  deleteDeletionIntent: (id: string) => Promise<void>,
): Promise<RemoteDeletionCandidate[]> {
  const providerSource = provider === "mal" ? "myanimelist" : "anilist";
  const candidates: RemoteDeletionCandidate[] = [];

  for (const intent of intents) {
    const remoteAnime = remoteSnapshot.anime.find(
      (anime) => anime.externalIds[providerSource] === intent.externalId,
    );
    const remoteEntry = remoteAnime
      ? remoteSnapshot.entries.find((entry) => entry.animeId === remoteAnime.id)
      : undefined;

    // The provider already reflects the requested deletion. Clear the intent
    // without issuing another destructive request.
    if (!remoteAnime || !remoteEntry) {
      await deleteDeletionIntent(intent.id);
      continue;
    }

    const entryId = provider === "anilist"
      ? Number(remoteEntry.sourceMetadata?.anilistEntryId)
      : undefined;
    if (provider === "anilist" && (!Number.isSafeInteger(entryId) || entryId! <= 0)) {
      throw new Error("Не удалось определить AniList entry ID для безопасного удаления. Запрос сохранён, ничего не удалено.");
    }

    candidates.push({
      intent,
      entry: { ...remoteEntry, animeId: intent.animeId, source: providerSource },
      ...(entryId !== undefined ? { entryId } : {}),
    });
  }

  return candidates;
}

export async function executeRemoteDeletions(
  provider: "mal" | "anilist",
  candidates: RemoteDeletionCandidate[],
  operations: SyncOperation[],
  dependencies: {
    deleteAccountEntry: (
      provider: "mal" | "anilist",
      input: { externalId: string; entryId?: number },
    ) => Promise<{ ok: boolean }>;
    deleteDeletionIntent: (id: string) => Promise<void>;
    updateSyncOperation: (
      id: string,
      update: Partial<SyncOperation>,
    ) => Promise<void>;
  },
): Promise<{ succeeded: number; deleted: number; failures: string[] }> {
  let succeeded = 0;
  let deleted = 0;
  const failures: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const operation = operations[index]!;
    await dependencies.updateSyncOperation(operation.id, {
      status: "in_progress",
      attempts: operation.attempts + 1,
    });

    try {
      await dependencies.deleteAccountEntry(provider, {
        externalId: candidate.intent.externalId,
        ...(candidate.entryId !== undefined ? { entryId: candidate.entryId } : {}),
      });
      await dependencies.deleteDeletionIntent(candidate.intent.id);
      await dependencies.updateSyncOperation(operation.id, { status: "succeeded" });
      succeeded += 1;
      deleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "ошибка удаления";
      await dependencies.updateSyncOperation(operation.id, {
        status: "failed",
        error: message,
      });
      failures.push(
        (candidate.intent.anime.titles.english ||
          candidate.intent.anime.titles.romaji ||
          candidate.intent.animeId) +
        " (удаление на сервисе: " + message + ")",
      );
    }
  }

  return { succeeded, deleted, failures };
}
