import type { SharedAnimeEntryMetadata, SyncProvider } from "./types.js";

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * Projects only semantically equivalent shared fields onto the destination
 * provider's metadata while retaining all destination-only fields.
 *
 * Notes/comments, tags, priorities and favorites are intentionally excluded:
 * their semantics or support differ between providers.
 */
export function mergeSharedMetadataIntoProviderMetadata(
  provider: SyncProvider,
  shared: SharedAnimeEntryMetadata | undefined,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = { ...existing };
  if (!shared) return result;

  const rewatchCount = validCount(shared.rewatchCount);
  if (rewatchCount !== undefined) {
    if (provider === "mal") result.timesRewatched = rewatchCount;
    else if (provider === "anilist") result.repeat = rewatchCount;
    else result.rewatches = rewatchCount;
  }

  if (provider === "mal") {
    if (validCalendarDate(shared.startedAt)) result.startDate = shared.startedAt;
    if (validCalendarDate(shared.completedAt)) result.finishDate = shared.completedAt;
  } else if (provider === "anilist") {
    if (validCalendarDate(shared.startedAt)) result.startedAt = shared.startedAt;
    if (validCalendarDate(shared.completedAt)) result.completedAt = shared.completedAt;
  }

  return result;
}
