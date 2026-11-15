import type { AnimeListEntry, SyncConflict } from "./types.js";

type SyncField = "status" | "progress" | "score" | "favorite";

export function detectConflicts(
  local: AnimeListEntry,
  remote: AnimeListEntry,
): SyncConflict[] {
  const fields: SyncField[] = ["status", "progress", "score", "favorite"];
  const conflicts: SyncConflict[] = [];

  for (const field of fields) {
    if (local[field] === remote[field]) continue;

    const lt = Date.parse(local.updatedAt);
    const rt = Date.parse(remote.updatedAt);

    const reason =
      !Number.isFinite(lt) || !Number.isFinite(rt)
        ? "unknown_order"
        : lt === rt
          ? "same_timestamp"
          : null;

    if (reason) {
      conflicts.push({
        animeId: local.animeId,
        field,
        localValue: local[field],
        remoteValue: remote[field],
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
        reason,
      });
    }
  }

  return conflicts;
}

export function chooseNewer(
  local: AnimeListEntry,
  remote: AnimeListEntry,
): AnimeListEntry | null {
  const lt = Date.parse(local.updatedAt);
  const rt = Date.parse(remote.updatedAt);

  if (!Number.isFinite(lt) || !Number.isFinite(rt) || lt === rt) {
    return null;
  }

  return rt > lt ? remote : local;
}

/**
 * Ищет конфликт статусов среди записей
 * с одинаковым максимальным прогрессом.
 */
export function detectMaxProgressStatusConflicts(
  entries: AnimeListEntry[],
): SyncConflict[] {
  if (entries.length < 2) return [];

  const maxProgress = Math.max(...entries.map((entry) => entry.progress));

  const candidates = entries.filter((entry) => entry.progress === maxProgress);

  if (candidates.length < 2) return [];

  const reference = candidates[0];

  if (!reference) return [];

  const conflicts: SyncConflict[] = [];

  for (const candidate of candidates.slice(1)) {
    if (candidate.status === reference.status) continue;

    conflicts.push({
      animeId: reference.animeId,
      field: "status",
      localValue: reference.status,
      remoteValue: candidate.status,
      localUpdatedAt: reference.updatedAt,
      remoteUpdatedAt: candidate.updatedAt,
      reason: "concurrent_change",
    });
  }

  return conflicts;
}
