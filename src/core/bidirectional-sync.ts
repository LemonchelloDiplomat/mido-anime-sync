import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
} from "./types.js";

export type SyncProvider = "mal" | "anilist";

export interface LocalSyncItem {
  anime: AnimeIdentity;
  entry?: AnimeListEntry;
}

export interface SyncFieldConflict {
  animeId: string;
  title: string;
  field: "status" | "progress" | "score" | "favorite";
  localValue: unknown;
  remoteValue: unknown;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  reason: "same_timestamp" | "unknown_order";
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

function titleOf(anime: AnimeIdentity): string {
  return anime.titles.english || anime.titles.romaji || anime.titles.native || anime.id;
}

function cloneEntry(entry: AnimeListEntry, animeId = entry.animeId): AnimeListEntry {
  return { ...structuredClone(entry), animeId };
}

/**
 * Builds a conservative, bidirectional plan. It never writes anything.
 * A single unresolved field conflict blocks the whole entry because both
 * provider write APIs update multiple fields in one operation.
 */
export function createBidirectionalSyncPlan(
  localItems: LocalSyncItem[],
  remoteSnapshot: AnimeSnapshotV4,
  provider: SyncProvider,
): SyncPlan {
  const service = provider === "mal" ? "myanimelist" : "anilist";
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
    skippedWithoutExternalId: 0,
  };

  for (const [externalId, local] of localByExternalId) {
    if (!local.entry) {
      plan.skippedWithoutExternalId += 1;
      continue;
    }
    const remote = remoteByExternalId.get(externalId);
    if (!remote) {
      plan.remoteCreates.push({ externalId, entry: cloneEntry(local.entry) });
      continue;
    }

    const localTime = timestamp(local.entry.updatedAt);
    const remoteTime = timestamp(remote.entry.updatedAt);
    const fields: Array<SyncField | "favorite"> = provider === "anilist"
      ? [...SYNC_FIELDS, "favorite"]
      : [...SYNC_FIELDS];
    const conflicts: SyncFieldConflict[] = [];
    const desired = cloneEntry(local.entry);
    let changed = false;

    for (const field of fields) {
      const localValue = local.entry[field];
      const remoteValue = remote.entry[field];
      if (localValue === remoteValue) continue;

      if (localTime === null || remoteTime === null || Math.abs(localTime - remoteTime) <= 1000) {
        conflicts.push({
          animeId: local.anime.id,
          title: titleOf(local.anime),
          field,
          localValue,
          remoteValue,
          localUpdatedAt: local.entry.updatedAt,
          remoteUpdatedAt: remote.entry.updatedAt,
          reason: "unknown_order",
        });
        continue;
      }
      if (localTime === remoteTime) {
        conflicts.push({
          animeId: local.anime.id,
          title: titleOf(local.anime),
          field,
          localValue,
          remoteValue,
          localUpdatedAt: local.entry.updatedAt,
          remoteUpdatedAt: remote.entry.updatedAt,
          reason: "same_timestamp",
        });
        continue;
      }

      changed = true;
      if (remoteTime > localTime) {
        (desired as unknown as Record<string, unknown>)[field] = remoteValue;
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

    const newestTimestamp = (remoteTime ?? 0) > (localTime ?? 0)
      ? remote.entry.updatedAt
      : local.entry.updatedAt;
    desired.updatedAt = newestTimestamp;

    const localDiffers = fields.some((field) => local.entry?.[field] !== desired[field]);
    const remoteDiffers = fields.some((field) => remote.entry[field] !== desired[field]);

    if (localDiffers) {
      plan.localUpdates.push({ animeId: local.anime.id, entry: { ...cloneEntry(desired, local.anime.id), source: provider === "mal" ? "myanimelist" : "anilist" } });
    }
    if (remoteDiffers) {
      plan.remoteUpdates.push({ externalId, entry: cloneEntry(desired, local.anime.id) });
    }
  }

  for (const [externalId, remote] of remoteByExternalId) {
    if (localByExternalId.has(externalId)) continue;
    plan.localCreates.push({
      anime: structuredClone(remote.anime),
      entry: cloneEntry(remote.entry, remote.anime.id),
    });
  }

  return plan;
}
