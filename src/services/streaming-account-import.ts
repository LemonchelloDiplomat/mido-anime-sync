import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "../core/types.js";

const EXACT_EXTERNAL_KEYS: Array<keyof AnimeIdentity["externalIds"]> = [
  "myanimelist",
  "anilist",
  "shikimori",
  "yummyanime",
  "animego",
  "anixart",
];

/**
 * Reconcile a streaming-site account snapshot against the current library.
 * Only exact shared external IDs are eligible. Title-only matches and
 * ambiguous many-to-one matches remain separate for a later user decision.
 */
export function reconcileStreamingAccountSnapshot(
  snapshot: AnimeSnapshotV4,
  existingAnime: AnimeIdentity[],
): AnimeSnapshotV4 {
  const candidates = new Map<string, string[]>();
  for (const incoming of snapshot.anime) {
    const matches = existingAnime.filter((local) =>
      EXACT_EXTERNAL_KEYS.some((key) => {
        const externalId = incoming.externalIds[key];
        return externalId != null && local.externalIds[key] === externalId;
      }),
    );
    candidates.set(incoming.id, matches.length === 1 ? [matches[0]!.id] : []);
  }

  const targetUseCount = new Map<string, number>();
  for (const targets of candidates.values()) {
    if (targets[0]) targetUseCount.set(targets[0], (targetUseCount.get(targets[0]) ?? 0) + 1);
  }

  const remappedIds = new Map<string, string>();
  for (const [sourceId, targets] of candidates) {
    const targetId = targets[0];
    if (targetId && targetUseCount.get(targetId) === 1) remappedIds.set(sourceId, targetId);
  }

  const localById = new Map(existingAnime.map((anime) => [anime.id, anime]));
  const animeById = new Map<string, AnimeIdentity>();
  for (const incoming of snapshot.anime) {
    const targetId = remappedIds.get(incoming.id) ?? incoming.id;
    const existing = localById.get(targetId);
    const genres = existing?.genres?.length ? existing.genres : incoming.genres;
    const merged: AnimeIdentity = existing ? {
      ...incoming,
      ...existing,
      id: targetId,
      titles: {
        ...incoming.titles,
        ...existing.titles,
        synonyms: [...new Set([...incoming.titles.synonyms, ...existing.titles.synonyms])],
      },
      externalIds: { ...incoming.externalIds, ...existing.externalIds },
      year: existing.year ?? incoming.year ?? null,
      episodes: existing.episodes ?? incoming.episodes ?? null,
      format: existing.format ?? incoming.format,
      ...(genres ? { genres } : {}),
      ageRating: existing.ageRating ?? incoming.ageRating ?? null,
      posterUrl: existing.posterUrl ?? incoming.posterUrl ?? null,
      averageScore: existing.averageScore ?? incoming.averageScore ?? null,
      startDate: existing.startDate ?? incoming.startDate ?? null,
      releaseStatus: existing.releaseStatus ?? incoming.releaseStatus,
    } : { ...incoming, id: targetId };
    const previous = animeById.get(targetId);
    if (previous) {
      animeById.set(targetId, {
        ...previous,
        externalIds: { ...merged.externalIds, ...previous.externalIds },
        titles: {
          ...merged.titles,
          ...previous.titles,
          synonyms: [...new Set([...merged.titles.synonyms, ...previous.titles.synonyms])],
        },
      });
    } else animeById.set(targetId, merged);
  }

  const remapEntry = (entry: AnimeListEntry): AnimeListEntry => ({
    ...entry,
    animeId: remappedIds.get(entry.animeId) ?? entry.animeId,
  });

  return {
    ...snapshot,
    anime: [...animeById.values()],
    entries: snapshot.entries.map(remapEntry),
    sourceEntries: snapshot.sourceEntries.map(remapEntry),
  };
}
