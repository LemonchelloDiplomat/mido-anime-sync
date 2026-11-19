import { getProviderServiceId, providerSupportsFavorite, providerUsesTenPointScore } from "./provider-capabilities.js";
import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "./types.js";
import type { LocalSyncItem, SyncProvider } from "./bidirectional-sync.js";

export interface RemoteDeletionCandidate {
  animeId: string;
  title: string;
  externalId: string;
  baseline: AnimeListEntry;
}

export interface RemoteDeletionConflict {
  animeId: string;
  title: string;
  externalId: string;
  baseline: AnimeListEntry;
  localEntry: AnimeListEntry;
}

export interface SafeDeletionDetection {
  /** Remote entries missing since the last successful baseline and safe to remove locally. */
  localRemovals: RemoteDeletionCandidate[];
  /** Local provider-specific edits conflict with a deletion observed remotely. */
  conflicts: RemoteDeletionConflict[];
  /** Refuse to infer deletions from an empty response when a non-empty baseline exists. */
  blockedReason: string | null;
  baselineCount: number;
  remoteCount: number;
  requiresBulkConfirmation: boolean;
}

function titleOf(anime: AnimeIdentity): string {
  return anime.titles.english || anime.titles.romaji || anime.titles.native || anime.id;
}

function comparableScore(provider: SyncProvider, value: number | null): number | null {
  if (!providerUsesTenPointScore(provider)) return value;
  if (value === null || value === 0) return null;
  return Math.max(10, Math.min(100, Math.round(value / 10) * 10));
}

function sameProviderEntry(
  provider: SyncProvider,
  baseline: AnimeListEntry,
  current: AnimeListEntry,
): boolean {
  return baseline.status === current.status &&
    baseline.progress === current.progress &&
    comparableScore(provider, baseline.score) === comparableScore(provider, current.score) &&
    (!providerSupportsFavorite(provider) || baseline.favorite === current.favorite);
}

/**
 * Detects deletions made directly on the remote service.
 *
 * A missing remote entry is only treated as a deletion when a successful
 * provider baseline exists. If the local entry changed
 * since that baseline, the deletion is surfaced as a conflict instead.
 * Empty remote lists are rejected when a non-empty baseline exists.
 */
export function detectRemoteDeletions(
  localItems: LocalSyncItem[],
  remoteSnapshot: AnimeSnapshotV4,
  provider: SyncProvider,
): SafeDeletionDetection {
  const service = getProviderServiceId(provider);
  const remoteIds = new Set(
    remoteSnapshot.anime
      .map((anime) => anime.externalIds[service])
      .filter((id): id is string => Boolean(id)),
  );

  const baselineItems = localItems.filter((item) =>
    Boolean(item.baseline?.source === getProviderServiceId(provider) &&
      item.anime.externalIds[service]),
  );
  const baselineCount = baselineItems.length;

  if (baselineCount > 0 && remoteSnapshot.entries.length === 0) {
    return {
      localRemovals: [],
      conflicts: [],
      blockedReason:
        "Удалённый сервис вернул пустой список, хотя ранее в базовом снимке были записи. Удаления заблокированы для защиты от неполного ответа API.",
      baselineCount,
      remoteCount: 0,
      requiresBulkConfirmation: false,
    };
  }

  const localRemovals: RemoteDeletionCandidate[] = [];
  const conflicts: RemoteDeletionConflict[] = [];

  for (const item of baselineItems) {
    const externalId = item.anime.externalIds[service]!;
    if (remoteIds.has(externalId)) continue;

    const baseline = item.baseline!;
    const currentEntry = item.entry;

    if (currentEntry && !sameProviderEntry(provider, baseline, currentEntry)) {
      conflicts.push({
        animeId: item.anime.id,
        title: titleOf(item.anime),
        externalId,
        baseline: structuredClone(baseline),
        localEntry: structuredClone(currentEntry),
      });
      continue;
    }

    localRemovals.push({
      animeId: item.anime.id,
      title: titleOf(item.anime),
      externalId,
      baseline: structuredClone(baseline),
    });
  }

  const requiresBulkConfirmation =
    localRemovals.length >= 10 ||
    (baselineCount > 0 && localRemovals.length / baselineCount >= 0.25);

  return {
    localRemovals,
    conflicts,
    blockedReason: null,
    baselineCount,
    remoteCount: remoteSnapshot.entries.length,
    requiresBulkConfirmation,
  };
}
