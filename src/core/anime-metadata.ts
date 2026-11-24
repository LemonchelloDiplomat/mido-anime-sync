import type { AnimeIdentity, AnimeProviderScore, ServiceId } from "./types.js";

export function createAnimeProviderScore(
  value: number,
  scale: number,
  options: Pick<AnimeProviderScore, "kind" | "voteCount" | "updatedAt"> = {},
): AnimeProviderScore {
  if (!Number.isFinite(value) || !Number.isFinite(scale) || scale <= 0 || value < 0 || value > scale) {
    throw new Error("Invalid provider score or score scale.");
  }
  return {
    value,
    scale,
    normalizedValue: Math.round((value / scale) * 10000) / 100,
    ...options,
  };
}

const ARRAY_FIELDS = ["genres", "themes", "demographics"] as const;
const NAMED_FIELDS = ["studios", "producers", "licensors", "staff"] as const;
const STRUCTURED_FIELDS = new Set([
  "id", "titles", "externalIds", ...ARRAY_FIELDS, "tags", ...NAMED_FIELDS,
  "providerScores", "providerMetadata",
]);

function mergeNonNullRecord<T extends Record<string, unknown>>(
  fallback: T | undefined,
  preferred: T | undefined,
): T {
  const result: Record<string, unknown> = { ...(fallback ?? {}), ...(preferred ?? {}) };
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) {
      const fallbackValue = fallback?.[key];
      if (fallbackValue !== null && fallbackValue !== undefined) result[key] = fallbackValue;
    }
  }
  return result as T;
}

/**
 * Merge metadata without collapsing provider-native ratings or source payloads.
 * Incoming non-null scalar fields win by default; null/undefined values are
 * treated as missing so incomplete provider responses cannot erase known data.
 * Set preferIncoming=false when the existing library record must remain authoritative.
 */
export function mergeAnimeMetadata(
  existing: AnimeIdentity,
  incoming: AnimeIdentity,
  options: { preferIncoming?: boolean } = {},
): AnimeIdentity {
  const preferIncoming = options.preferIncoming ?? true;
  const preferred = preferIncoming ? incoming : existing;
  const fallback = preferIncoming ? existing : incoming;
  const merged = { ...fallback, ...preferred, id: existing.id };

  // Null is common in partial catalog responses. Preserve a known scalar value
  // rather than interpreting an unavailable field as an explicit deletion.
  const mergedRecord = merged as unknown as Record<string, unknown>;
  const preferredRecord = preferred as unknown as Record<string, unknown>;
  const fallbackRecord = fallback as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
    if (STRUCTURED_FIELDS.has(key)) continue;
    const value = preferredRecord[key];
    if ((value === null || value === undefined) &&
      fallbackRecord[key] !== null && fallbackRecord[key] !== undefined) {
      mergedRecord[key] = fallbackRecord[key];
    }
  }

  for (const field of ARRAY_FIELDS) {
    const values = [...new Set([...(existing[field] ?? []), ...(incoming[field] ?? [])])];
    if (values.length) Object.assign(merged, { [field]: values });
  }

  const preferredOrder = preferIncoming ? [existing, incoming] : [incoming, existing];
  const mergedTags = new Map<string, NonNullable<AnimeIdentity["tags"]>[number]>();
  for (const record of preferredOrder) {
    for (const tag of record.tags ?? []) {
      const key = [tag.name.trim().toLocaleLowerCase(), tag.category ?? ""].join("|");
      mergedTags.set(key, tag);
    }
  }
  if (mergedTags.size) merged.tags = [...mergedTags.values()];

  const mergeNamed = <T extends { name: string; externalId?: string | null; role?: string | null; language?: string | null }>(
    records: Array<T[] | undefined>,
  ): T[] => {
    const values = new Map<string, T>();
    for (const items of records) {
      for (const item of items ?? []) {
        const key = [item.name.trim().toLocaleLowerCase(), item.externalId ?? "", item.role ?? "", item.language ?? ""].join("|");
        values.set(key, item);
      }
    }
    return [...values.values()];
  };
  for (const field of NAMED_FIELDS) {
    const values = mergeNamed(preferredOrder.map((record) => record[field]));
    if (values.length) Object.assign(merged, { [field]: values });
  }

  merged.titles = {
    ...incoming.titles,
    ...existing.titles,
    ...(preferIncoming ? incoming.titles : existing.titles),
    synonyms: [...new Set([...(existing.titles.synonyms ?? []), ...(incoming.titles.synonyms ?? [])])],
  };
  merged.externalIds = { ...incoming.externalIds, ...existing.externalIds };

  const scoreProviders = new Set<ServiceId>([
    ...Object.keys(existing.providerScores ?? {}) as ServiceId[],
    ...Object.keys(incoming.providerScores ?? {}) as ServiceId[],
  ]);
  if (scoreProviders.size) {
    merged.providerScores = {};
    for (const provider of scoreProviders) {
      const preferredMetrics = preferIncoming ? incoming.providerScores?.[provider] : existing.providerScores?.[provider];
      const fallbackMetrics = preferIncoming ? existing.providerScores?.[provider] : incoming.providerScores?.[provider];
      merged.providerScores[provider] = mergeNonNullRecord(fallbackMetrics, preferredMetrics);
    }
  }

  const metadataProviders = new Set<ServiceId>([
    ...Object.keys(existing.providerMetadata ?? {}) as ServiceId[],
    ...Object.keys(incoming.providerMetadata ?? {}) as ServiceId[],
  ]);
  if (metadataProviders.size) {
    merged.providerMetadata = {};
    for (const provider of metadataProviders) {
      const preferredPayload = preferIncoming ? incoming.providerMetadata?.[provider] : existing.providerMetadata?.[provider];
      const fallbackPayload = preferIncoming ? existing.providerMetadata?.[provider] : incoming.providerMetadata?.[provider];
      merged.providerMetadata[provider] = mergeNonNullRecord(fallbackPayload, preferredPayload);
    }
  }

  return merged;
}
