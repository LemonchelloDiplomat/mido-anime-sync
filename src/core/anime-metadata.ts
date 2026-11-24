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
 * The existing record wins by default; pass preferIncoming to let a fresh
 * provider response update canonical scalar fields.
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

  for (const field of ["tags", "studios", "producers", "licensors", "staff"] as const) {
    const left = existing[field] ?? [];
    const right = incoming[field] ?? [];
    const key = (item: (typeof left)[number]) =>
      [item.name.trim().toLocaleLowerCase(), item.externalId ?? "", item.role ?? ""].join("|");
    const values = new Map<string, (typeof left)[number]>();
    for (const item of [...left, ...right]) values.set(key(item), item);
    if (values.size) Object.assign(merged, { [field]: [...values.values()] });
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
      merged.providerScores[provider] = {
        ...existing.providerScores?.[provider],
        ...incoming.providerScores?.[provider],
      };
    }
  }

  const metadataProviders = new Set<ServiceId>([
    ...Object.keys(existing.providerMetadata ?? {}) as ServiceId[],
    ...Object.keys(incoming.providerMetadata ?? {}) as ServiceId[],
  ]);
  if (metadataProviders.size) {
    merged.providerMetadata = {};
    for (const provider of metadataProviders) {
      merged.providerMetadata[provider] = {
        ...existing.providerMetadata?.[provider],
        ...incoming.providerMetadata?.[provider],
      };
    }
  }

  return merged;
}
