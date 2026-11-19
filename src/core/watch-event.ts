import type { AnimeIdentity, AnimeListEntry } from "./types.js";

export interface IncomingWatchEvent {
  eventId: string;
  provider: "animego" | "yummyanime";
  title: string;
  episode: number;
  sourceUrl: string;
  watchedAt: string;
}

export function normalizeWatchTitle(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .trim()
    .replace(/\\s+/g, " ");
}

/** Only exact normalized title matches are eligible for automatic progress updates. */
export function findExactAnimeTitleMatches(
  anime: AnimeIdentity[],
  rawTitle: string,
): AnimeIdentity[] {
  const query = normalizeWatchTitle(rawTitle);
  if (!query) return [];

  return anime.filter((identity) => {
    const titles = [
      identity.titles.english,
      identity.titles.romaji,
      identity.titles.native,
      ...identity.titles.synonyms,
    ].filter((title): title is string => Boolean(title));

    return titles.some((title) => normalizeWatchTitle(title) === query);
  });
}

export function createLocalWatchProgressEntry(
  anime: AnimeIdentity,
  existing: AnimeListEntry | undefined,
  event: IncomingWatchEvent,
  updatedAt = new Date().toISOString(),
): AnimeListEntry {
  if (!Number.isSafeInteger(event.episode) || event.episode <= 0) {
    throw new Error("Номер серии должен быть положительным целым числом.");
  }
  if (!Number.isFinite(Date.parse(event.watchedAt))) {
    throw new Error("У события просмотра некорректная дата.");
  }

  const progress = Math.max(existing?.progress ?? 0, event.episode);
  const isCompleted = existing?.status === "COMPLETED" ||
    (anime.episodes != null && anime.episodes > 0 && progress >= anime.episodes);

  return {
    animeId: anime.id,
    source: "local",
    status: isCompleted ? "COMPLETED" : "WATCHING",
    progress,
    score: existing?.score ?? null,
    favorite: existing?.favorite ?? false,
    updatedAt,
    sourceMetadata: {
      ...(existing?.sourceMetadata ?? {}),
      lastWatchSource: event.provider,
      lastWatchSourceUrl: event.sourceUrl,
      lastWatchDetectedAt: event.watchedAt,
    },
  };
}
