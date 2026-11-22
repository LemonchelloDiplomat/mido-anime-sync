import { getProviderServiceId, providerSupportsFavorite, providerUsesTenPointScore } from "./provider-capabilities.js";
import type {
  AnimeListEntry,
  AnimeSnapshot,
  SyncOperation,
  SyncProvider,
} from "./types.js";

const PROVIDER_METADATA_FIELDS: Record<SyncProvider, string[]> = {
  mal: ["timesRewatched", "rewatchValue", "tags", "comments", "priority", "startDate", "finishDate"],
  anilist: ["repeat", "notes", "startedAt", "completedAt"],
  shikimori: ["rewatches", "text"],
};

function providerMetadataMatches(
  provider: SyncProvider,
  expected: AnimeListEntry,
  actual: AnimeListEntry,
): boolean {
  const expectedMetadata = expected.sourceMetadata;
  if (!expectedMetadata) return true;
  const actualMetadata = actual.sourceMetadata ?? {};
  return PROVIDER_METADATA_FIELDS[provider].every((field) => {
    if (!(field in expectedMetadata)) return true;
    return JSON.stringify(expectedMetadata[field]) === JSON.stringify(actualMetadata[field]);
  });
}

export interface SyncRecoveryDependencies {
  getSourceEntries: (animeId: string) => Promise<AnimeListEntry[]>;
  updateSyncOperation: (
    id: string,
    update: Partial<Pick<SyncOperation, "status" | "attempts" | "error">>,
  ) => Promise<void>;
}

/**
 * Reconciles unfinished journal records with a freshly fetched provider
 * snapshot and the current local source entries. This is a best-effort
 * recovery check, not a distributed transaction.
 */
export async function reconcileUnfinishedSyncOperations(
  operations: SyncOperation[],
  provider: SyncProvider,
  remoteSnapshot: AnimeSnapshot,
  dependencies: SyncRecoveryDependencies,
): Promise<{ recoveredOperations: number }> {
  const providerSource = getProviderServiceId(provider);
  let recoveredOperations = 0;

  for (const operation of operations) {
    const actualEntry = operation.direction === "remote"
      ? (() => {
          const remoteAnime = remoteSnapshot.anime.find(
            (anime) => anime.externalIds[providerSource] === operation.externalId,
          );
          return remoteAnime
            ? remoteSnapshot.entries.find((entry) => entry.animeId === remoteAnime.id)
            : undefined;
        })()
      : (await dependencies.getSourceEntries(operation.animeId)).find(
          (entry) => entry.source === operation.entry.source,
        );

    const expectedScore = providerUsesTenPointScore(provider)
      ? operation.entry.score === null || operation.entry.score === 0
        ? null
        : Math.max(10, Math.min(100, Math.round(operation.entry.score / 10) * 10))
      : operation.entry.score;

    const matchesTarget = operation.kind === "delete"
      ? !actualEntry
      : Boolean(
          actualEntry &&
          actualEntry.status === operation.entry.status &&
          actualEntry.progress === operation.entry.progress &&
          actualEntry.score === expectedScore &&
          (!providerSupportsFavorite(provider) || actualEntry.favorite === operation.entry.favorite) &&
          providerMetadataMatches(provider, operation.entry, actualEntry),
        );

    if (matchesTarget) {
      await dependencies.updateSyncOperation(operation.id, { status: "succeeded" });
      recoveredOperations += 1;
    } else {
      await dependencies.updateSyncOperation(operation.id, {
        status: "failed",
        error: "Восстановление: текущее состояние не совпадает с целевым. Повторная синхронизация построит новый план.",
      });
    }
  }

  return { recoveredOperations };
}
