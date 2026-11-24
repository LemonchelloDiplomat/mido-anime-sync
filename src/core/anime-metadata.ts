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

const ARRAY_FIELDS = [
  "genres", "themes", "demographics",
] as const;

/**
 * Merge metadata without collapsing provider-native ratings or source payloads.
 * Incoming scalar fields win by default; set preferIncoming=false when the
 * existing library record must remain authoritative.
 */
export function mergeAnimeMetadata(
  existing: AnimeIdentity,
  incoming: AnimeIdentity,
  options: { preferIncoming?: boolean } = {},
): AnimeIdentity {
  const preferIncoming = options.preferIncoming ?? true;
  const first = preferIncoming ? existing : incoming;
  const second = preferIncoming ? incoming : existing;
  const merged = { ...first, ...second, id: existing.id };

  for (const field of ARRAY_FIELDS) {
    const values = [...new Set([...(existing[field] ?? []), ...(incoming[field] ?? [])])];
    if (values.length) Object.assign(merged, { [field]: values });
  }

  const preferredOrder = preferIncoming
    ? [existing, incoming]
    : [incoming, existing];

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
  for (const field of ["studios", "producers", "licensors", "staff"] as const) {
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
      const preferred = preferIncoming ? incoming.providerScores?.[provider] : existing.providerScores?.[provider];
      const fallback = preferIncoming ? existing.providerScores?.[provider] : incoming.providerScores?.[provider];
      merged.providerScores[provider] = { ...fallback, ...preferred };
    }
  }

  const metadataProviders = new Set<ServiceId>([
    ...Object.keys(existing.providerMetadata ?? {}) as ServiceId[],
    ...Object.keys(incoming.providerMetadata ?? {}) as ServiceId[],
  ]);
  if (metadataProviders.size) {
    merged.providerMetadata = {};
    for (const provider of metadataProviders) {
      const preferred = preferIncoming ? incoming.providerMetadata?.[provider] : existing.providerMetadata?.[provider];
      const fallback = preferIncoming ? existing.providerMetadata?.[provider] : incoming.providerMetadata?.[provider];
      merged.providerMetadata[provider] = { ...fallback, ...preferred };
    }
  }

  return merged;
}
