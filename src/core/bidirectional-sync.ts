import { getProviderServiceId, providerSupportsFavorite, providerUsesTenPointScore } from "./provider-capabilities.js";
import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  SyncProvider,
} from "./types.js";

export type { SyncProvider } from "./types.js";

export interface LocalSyncItem {
  anime: AnimeIdentity;
  entry?: AnimeListEntry | undefined;
  /** Last known copy of this provider's entry, persisted after a successful sync/import. */
  baseline?: AnimeListEntry | undefined;
}

export interface SyncFieldConflict {
  animeId: string;
  title: string;
  field: "status" | "progress" | "score" | "favorite";
  localValue: unknown;
  remoteValue: unknown;
  baselineValue?: unknown;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  reason: "same_timestamp" | "unknown_order" | "both_changed";
}

/**
 * A provider baseline represents a fully reconciled state. Never advance it
 * after partial writes or while the user has left any conflict unresolved.
 */
export function canAdvanceSyncBaseline(
  failedWrites: number,
  unresolvedConflicts: number,
): boolean {
  return failedWrites === 0 && unresolvedConflicts === 0;
}

export interface SyncPlan {
  provider: SyncProvider;
  remoteCreates: Array<{ externalId: string; entry: AnimeListEntry }>;
  remoteUpdates: Array<{ externalId: string; entry: AnimeListEntry }>;
  localCreates: Array<{ anime: AnimeIdentity; entry: AnimeListEntry }>;
  localUpdates: Array<{ animeId: string; entry: AnimeListEntry }>;
  conflicts: SyncFieldConflict[];
  unchanged: number;
  skippedWithoutExternalId: number;
}

const SYNC_FIELDS = ["status", "progress", "score"] as const;
type SyncField = (typeof SYNC_FIELDS)[number];

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * MAL stores integer scores from 1 to 10. Values in the app are 0–100,
 * so compare scores at MAL's actual precision to avoid perpetual updates
 * for values such as 84 that MAL necessarily stores as 80.
 */
function comparableFieldValue(
  provider: SyncProvider,
  field: SyncField | "favorite",
  value: unknown,
): unknown {
  if (!providerUsesTenPointScore(provider) || field !== "score") return value;
  if (value == null || value === 0) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return Math.max(10, Math.min(100, Math.round(numeric / 10) * 10));
}

function titleOf(anime: AnimeIdentity): string {
  return anime.titles.english || anime.titles.romaji || anime.titles.native || anime.id;
}

function cloneEntry(entry: AnimeListEntry, animeId = entry.animeId): AnimeListEntry {
  return { ...structuredClone(entry), animeId };
}

/**
 * Builds a conservative, bidirectional plan. It never writes anything.
 * With a stored baseline it performs a three-way, field-by-field merge.
 * Without a baseline it falls back to timestamps, treating provider timestamp
 * precision (one second) as ambiguous.
 *
 * A single unresolved field conflict blocks the whole entry because the
 * provider write APIs update multiple fields in one operation.
 */
export function createBidirectionalSyncPlan(
  localItems: LocalSyncItem[],
  remoteSnapshot: AnimeSnapshotV4,
  provider: SyncProvider,
): SyncPlan {
  const service = getProviderServiceId(provider);
  const localByExternalId = new Map<string, LocalSyncItem>();
  const remoteByExternalId = new Map<string, { anime: AnimeIdentity; entry: AnimeListEntry }>();
  const remoteEntryByAnimeId = new Map(remoteSnapshot.entries.map((entry) => [entry.animeId, entry]));

  for (const item of localItems) {
    const externalId = item.anime.externalIds[service];
    if (!externalId) continue;
    if (localByExternalId.has(externalId)) {
      throw new Error("В локальной библиотеке несколько аниме имеют один внешний ID " + service + ":" + externalId);
    }
    localByExternalId.set(externalId, item);
  }

  for (const anime of remoteSnapshot.anime) {
    const externalId = anime.externalIds[service];
    const entry = remoteEntryByAnimeId.get(anime.id);
    if (!externalId || !entry) continue;
    if (remoteByExternalId.has(externalId)) {
      throw new Error("Удалённый сервис вернул несколько записей с одним ID " + service + ":" + externalId);
    }
    remoteByExternalId.set(externalId, { anime, entry });
  }

  const plan: SyncPlan = {
    provider,
    remoteCreates: [],
    remoteUpdates: [],
    localCreates: [],
    localUpdates: [],
    conflicts: [],
    unchanged: 0,
    skippedWithoutExternalId: localItems.filter((item) => Boolean(item.entry) && !item.anime.externalIds[service]).length,
  };

  for (const [externalId, local] of localByExternalId) {
    if (!local.entry) continue;
    const remote = remoteByExternalId.get(externalId);
    if (!remote) {
      // A stored baseline proves this entry existed remotely before. Its
      // absence is handled by the safe-deletion planner, never as a create.
      if (!local.baseline) {
        plan.remoteCreates.push({ externalId, entry: cloneEntry(local.entry) });
      }
      continue;
    }

    const localTime = timestamp(local.entry.updatedAt);
    const remoteTime = timestamp(remote.entry.updatedAt);
    const fields: Array<SyncField | "favorite"> = providerSupportsFavorite(provider)
      ? [...SYNC_FIELDS, "favorite"]
      : [...SYNC_FIELDS];
    const conflicts: SyncFieldConflict[] = [];
    const desired = cloneEntry(local.entry);
    let changed = false;
    let newestChangedTime: number | null = null;

    for (const field of fields) {
      const localValue = local.entry[field];
      const remoteValue = remote.entry[field];
      const comparableLocalValue = comparableFieldValue(provider, field, localValue);
      const comparableRemoteValue = comparableFieldValue(provider, field, remoteValue);
      if (comparableLocalValue === comparableRemoteValue) continue;

      if (local.baseline) {
        const baselineValue = local.baseline[field];
        const comparableBaselineValue = comparableFieldValue(provider, field, baselineValue);
        const localChanged = comparableLocalValue !== comparableBaselineValue;
        const remoteChanged = comparableRemoteValue !== comparableBaselineValue;

        if (localChanged && remoteChanged) {
          conflicts.push({
            animeId: local.anime.id,
            title: titleOf(local.anime),
            field,
            localValue,
            remoteValue,
            baselineValue,
            localUpdatedAt: local.entry.updatedAt,
            remoteUpdatedAt: remote.entry.updatedAt,
            reason: "both_changed",
          });
          continue;
        }

        changed = true;
        if (remoteChanged) {
          (desired as unknown as Record<string, unknown>)[field] = remoteValue;
          if (remoteTime !== null) newestChangedTime = Math.max(newestChangedTime ?? remoteTime, remoteTime);
        } else if (localChanged) {
          if (localTime !== null) newestChangedTime = Math.max(newestChangedTime ?? localTime, localTime);
        }
        continue;
      }

      // First sync or legacy data without a baseline: timestamps are the only
      // available ordering signal, so never guess when ordering is uncertain.
      if (localTime === null || remoteTime === null || Math.abs(localTime - remoteTime) <= 1000) {
        conflicts.push({
          animeId: local.anime.id,
          title: titleOf(local.anime),
          field,
          localValue,
          remoteValue,
          localUpdatedAt: local.entry.updatedAt,
          remoteUpdatedAt: remote.entry.updatedAt,
          reason: localTime === null || remoteTime === null ? "unknown_order" : "same_timestamp",
        });
        continue;
      }

      changed = true;
      if (remoteTime > localTime) {
        (desired as unknown as Record<string, unknown>)[field] = remoteValue;
        newestChangedTime = Math.max(newestChangedTime ?? 0, remoteTime);
      } else {
        newestChangedTime = Math.max(newestChangedTime ?? 0, localTime);
      }
    }

    if (conflicts.length) {
      plan.conflicts.push(...conflicts);
      continue;
    }

    if (!changed) {
      plan.unchanged += 1;
      continue;
    }

    if (newestChangedTime !== null) {
      desired.updatedAt = new Date(newestChangedTime).toISOString();
    }

    const localDiffers = fields.some((field) =>
      comparableFieldValue(provider, field, local.entry?.[field]) !==
      comparableFieldValue(provider, field, desired[field])
    );
    const remoteDiffers = fields.some((field) =>
      comparableFieldValue(provider, field, remote.entry[field]) !==
      comparableFieldValue(provider, field, desired[field])
    );

    if (localDiffers) {
      plan.localUpdates.push({
        animeId: local.anime.id,
        entry: { ...cloneEntry(desired, local.anime.id), source: getProviderServiceId(provider) },
      });
    }
    if (remoteDiffers) {
      plan.remoteUpdates.push({ externalId, entry: cloneEntry(desired, local.anime.id) });
    }
  }

  for (const [externalId, remote] of remoteByExternalId) {
    const local = localByExternalId.get(externalId);
    if (!local) {
      plan.localCreates.push({
        anime: structuredClone(remote.anime),
        entry: cloneEntry(remote.entry, remote.anime.id),
      });
      continue;
    }

    // The catalog may already contain this anime without a watch-list entry.
    // Attach the provider's entry to that canonical record instead of skipping
    // it or creating a duplicate anime identity.
    if (!local.entry) {
      plan.localUpdates.push({
        animeId: local.anime.id,
        entry: {
          ...cloneEntry(remote.entry, local.anime.id),
          source: getProviderServiceId(provider),
        },
      });
    }
  }

  return plan;
}
