import type {
  AnimeIdentity,
  AnimeSnapshotV4,
  ConflictResolution,
} from "./types.js";

export type RestoreCollection =
  | "anime"
  | "sourceEntries"
  | "conflictResolutions"
  | "animeRelations";

export type RestoreChangeStatus = "added" | "updated" | "unchanged" | "removed";

export interface RestorePreviewItem {
  collection: RestoreCollection;
  key: string;
  status: RestoreChangeStatus;
  current: unknown | null;
  backup: unknown | null;
}

export interface RestorePreviewConflict {
  animeId: string;
  service: string;
  currentExternalId: string;
  backupExternalId: string;
  reason: "changed" | "reassigned";
}

export interface RestorePreview {
  items: RestorePreviewItem[];
  conflicts: RestorePreviewConflict[];
  summary: {
    total: number;
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
    conflicts: number;
  };
  collections: Record<
    RestoreCollection,
    { added: number; updated: number; unchanged: number; removed: number }
  >;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }

  return value;
}

function areEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function getKey(collection: RestoreCollection, value: unknown): string {
  const item = value as Record<string, unknown>;

  switch (collection) {
    case "anime":
      return String(item.id);
    case "sourceEntries":
      return JSON.stringify([item.animeId, item.source]);
    case "conflictResolutions":
      return String(item.animeId);
    case "animeRelations":
      return String(item.id);
  }
}

function compareCollection<T>(
  collection: RestoreCollection,
  currentItems: T[],
  backupItems: T[],
): RestorePreviewItem[] {
  const currentByKey = new Map(
    currentItems.map((item) => [getKey(collection, item), item]),
  );
  const backupByKey = new Map(
    backupItems.map((item) => [getKey(collection, item), item]),
  );
  const result: RestorePreviewItem[] = [];

  for (const [key, backup] of backupByKey) {
    const current = currentByKey.get(key);

    result.push({
      collection,
      key,
      status:
        current === undefined
          ? "added"
          : areEqual(current, backup)
            ? "unchanged"
            : "updated",
      current: current === undefined ? null : current,
      backup,
    });
  }

  for (const [key, current] of currentByKey) {
    if (!backupByKey.has(key)) {
      result.push({
        collection,
        key,
        status: "removed",
        current,
        backup: null,
      });
    }
  }

  return result;
}

function getCurrentConflictResolutions(
  sourceEntries: AnimeSnapshotV4["sourceEntries"],
  resolutions: ConflictResolution[],
): ConflictResolution[] {
  const entriesByAnimeId = new Map<string, typeof sourceEntries>();

  for (const entry of sourceEntries) {
    const group = entriesByAnimeId.get(entry.animeId) ?? [];
    group.push(entry);
    entriesByAnimeId.set(entry.animeId, group);
  }

  const current: ConflictResolution[] = [];

  for (const resolution of resolutions) {
    const entries = entriesByAnimeId.get(resolution.animeId);
    if (!entries?.length) continue;

    const fingerprint = JSON.stringify(
      [...entries]
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((entry) => ({
          source: entry.source,
          status: entry.status,
          progress: entry.progress,
          updatedAt: entry.updatedAt,
        })),
    );

    if (resolution.fingerprint === fingerprint) current.push(resolution);
  }

  return current;
}

function findExternalIdConflicts(
  currentAnime: AnimeIdentity[],
  backupAnime: AnimeIdentity[],
): RestorePreviewConflict[] {
  const currentByExternalId = new Map<string, AnimeIdentity>();

  for (const anime of currentAnime) {
    for (const [service, externalId] of Object.entries(anime.externalIds)) {
      if (externalId) {
        currentByExternalId.set(JSON.stringify([service, externalId]), anime);
      }
    }
  }

  const conflicts: RestorePreviewConflict[] = [];
  const seen = new Set<string>();

  for (const backup of backupAnime) {
    for (const [service, backupExternalId] of Object.entries(backup.externalIds)) {
      if (!backupExternalId) continue;

      const currentSameId = currentAnime.find((anime) => anime.id === backup.id);
      const currentExternalId =
        currentSameId?.externalIds[service as keyof AnimeIdentity["externalIds"]];

      if (currentExternalId && currentExternalId !== backupExternalId) {
        const key = JSON.stringify([backup.id, service, currentExternalId, backupExternalId]);
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({
            animeId: backup.id,
            service,
            currentExternalId,
            backupExternalId,
            reason: "changed",
          });
        }
      }

      const owner = currentByExternalId.get(JSON.stringify([service, backupExternalId]));
      if (owner && owner.id !== backup.id) {
        const key = JSON.stringify([backup.id, service, owner.id, backupExternalId]);
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.push({
            animeId: backup.id,
            service,
            currentExternalId: `${backupExternalId} (anime ${owner.id})`,
            backupExternalId,
            reason: "reassigned",
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Compares a validated backup with the current database snapshot.
 * This is a read-only comparison: it never mutates either snapshot.
 */
export function createRestorePreview(
  backup: AnimeSnapshotV4,
  current: AnimeSnapshotV4,
): RestorePreview {
  const items = [
    ...compareCollection("anime", current.anime, backup.anime),
    ...compareCollection("sourceEntries", current.sourceEntries, backup.sourceEntries),
    ...compareCollection(
      "conflictResolutions",
      current.conflictResolutions,
      getCurrentConflictResolutions(backup.sourceEntries, backup.conflictResolutions),
    ),
    ...compareCollection("animeRelations", current.animeRelations, backup.animeRelations),
  ];

  const collections = {
    anime: { added: 0, updated: 0, unchanged: 0, removed: 0 },
    sourceEntries: { added: 0, updated: 0, unchanged: 0, removed: 0 },
    conflictResolutions: { added: 0, updated: 0, unchanged: 0, removed: 0 },
    animeRelations: { added: 0, updated: 0, unchanged: 0, removed: 0 },
  };

  const summary = {
    total: items.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    conflicts: 0,
  };

  for (const item of items) {
    summary[item.status]++;
    collections[item.collection][item.status]++;
  }

  const conflicts = findExternalIdConflicts(current.anime, backup.anime);
  summary.conflicts = conflicts.length;

  return { items, conflicts, summary, collections };
}
