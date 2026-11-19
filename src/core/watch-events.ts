import type { AnimeIdentity, AnimeSourceEntry, ServiceId } from "./types.js";

export type WatchSource = "animego" | "anixart" | "yummyanime";

export interface WatchEvent {
  service: WatchSource;
  title: string;
  episode: number;
  sourceUrl: string;
  observedAt: string;
  currentTimeSeconds?: number | null;
  durationSeconds?: number | null;
}

export function isWatchSource(value: unknown): value is WatchSource {
  return value === "animego" || value === "anixart" || value === "yummyanime";
}

export function validateWatchEvent(value: unknown): WatchEvent {
  if (!value || typeof value !== "object") throw new Error("Некорректное событие просмотра.");
  const event = value as Record<string, unknown>;
  if (
    !isWatchSource(event.service) ||
    typeof event.title !== "string" ||
    event.title.trim().length === 0 ||
    !Number.isInteger(event.episode) ||
    Number(event.episode) < 1 ||
    typeof event.sourceUrl !== "string" ||
    !/^https?:\/\//i.test(event.sourceUrl) ||
    typeof event.observedAt !== "string" ||
    !Number.isFinite(Date.parse(event.observedAt))
  ) {
    throw new Error("Событие просмотра содержит некорректные данные.");
  }

  const optionalNumber = (field: string): number | null | undefined => {
    const raw = event[field];
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new Error("Некорректное значение " + field + " в событии просмотра.");
    }
    return raw;
  };

  return {
    service: event.service,
    title: event.title.trim(),
    episode: Number(event.episode),
    sourceUrl: event.sourceUrl,
    observedAt: new Date(event.observedAt).toISOString(),
    ...(optionalNumber("currentTimeSeconds") !== undefined
      ? { currentTimeSeconds: optionalNumber("currentTimeSeconds") }
      : {}),
    ...(optionalNumber("durationSeconds") !== undefined
      ? { durationSeconds: optionalNumber("durationSeconds") }
      : {}),
  };
}

function normalizeTitle(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .trim()
    .replace(/\\s+/g, " ");
}

/** Match only exact normalized aliases. Ambiguous results must be confirmed manually. */
export function findExactAnimeTitleMatches(
  anime: AnimeIdentity[],
  rawTitle: string,
): AnimeIdentity[] {
  const query = normalizeTitle(rawTitle);
  if (!query) return [];

  return anime.filter((identity) => [
    identity.titles.english,
    identity.titles.romaji,
    identity.titles.native,
    ...identity.titles.synonyms,
  ].some((title) => typeof title === "string" && normalizeTitle(title) === query));
}

export function createWatchSourceEntry(
  anime: AnimeIdentity,
  event: WatchEvent,
  existing?: AnimeSourceEntry,
): AnimeSourceEntry {
  const source: ServiceId = event.service;
  const progress = Math.max(existing?.progress ?? 0, event.episode);
  const completed = typeof anime.episodes === "number" && anime.episodes > 0 &&
    progress >= anime.episodes;
  const previousUpdatedAt = existing?.updatedAt ? Date.parse(existing.updatedAt) : Number.NaN;
  const eventUpdatedAt = Date.parse(event.observedAt);
  const updatedAt = Number.isFinite(previousUpdatedAt) && previousUpdatedAt > eventUpdatedAt
    ? existing!.updatedAt
    : event.observedAt;
  const previousWatchedAt = Date.parse(String(existing?.sourceMetadata?.lastWatchedAt ?? ""));
  const isNewestEvent = !Number.isFinite(previousWatchedAt) || eventUpdatedAt >= previousWatchedAt;
  const previousEpisode = Number(existing?.sourceMetadata?.lastEpisode);
  const sourceMetadata = {
    ...(existing?.sourceMetadata ?? {}),
    lastEpisode: Number.isSafeInteger(previousEpisode)
      ? Math.max(previousEpisode, event.episode)
      : event.episode,
    ...(isNewestEvent ? {
      lastWatchedUrl: event.sourceUrl,
      lastWatchedAt: event.observedAt,
      ...(event.currentTimeSeconds !== undefined ? { lastPositionSeconds: event.currentTimeSeconds } : {}),
      ...(event.durationSeconds !== undefined ? { lastDurationSeconds: event.durationSeconds } : {}),
    } : {}),
  };

  return {
    animeId: anime.id,
    source,
    status: completed
      ? "COMPLETED"
      : progress > (existing?.progress ?? 0)
        ? "WATCHING"
        : existing?.status ?? "WATCHING",
    progress,
    score: existing?.score ?? null,
    favorite: existing?.favorite ?? false,
    updatedAt,
    sourceMetadata,
  };
}
