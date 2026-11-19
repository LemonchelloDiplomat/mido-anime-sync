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
  let sourceUrl: URL | null = null;
  try {
    sourceUrl = typeof event.sourceUrl === "string" ? new URL(event.sourceUrl) : null;
  } catch {
    sourceUrl = null;
  }
  const host = sourceUrl?.hostname.toLowerCase() ?? "";
  const allowedHost = event.service === "animego"
    ? host === "anime-go.org" || host.endsWith(".anime-go.org") || host === "animego.online" || host.endsWith(".animego.online")
    : event.service === "yummyanime"
      ? ["yummyani.me", "yummy-ani.me", "yummyanime.club", "yummyanime.info"].some((domain) => host === domain || host.endsWith("." + domain))
      : event.service === "anixart"
        ? host === "anixart-app.com" || host.endsWith(".anixart-app.com")
        : false;
  if (

    !isWatchSource(event.service) ||
    typeof event.title !== "string" ||
    event.title.trim().length === 0 ||
    !Number.isInteger(event.episode) ||
    Number(event.episode) < 1 ||
    !sourceUrl ||
    (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") ||
    Boolean(sourceUrl.username || sourceUrl.password) ||
    !allowedHost ||
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
  const currentTimeSeconds = optionalNumber("currentTimeSeconds");
  const durationSeconds = optionalNumber("durationSeconds");

  return {
    service: event.service,
    title: event.title.trim(),
    episode: Number(event.episode),
    sourceUrl: event.sourceUrl,
    observedAt: new Date(event.observedAt).toISOString(),
    ...(currentTimeSeconds !== undefined ? { currentTimeSeconds } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
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

  return {
    animeId: anime.id,
    source,
    status: completed ? "COMPLETED" : "WATCHING",
    progress,
    score: existing?.score ?? null,
    favorite: existing?.favorite ?? false,
    updatedAt: event.observedAt,
    sourceMetadata: {
      ...(existing?.sourceMetadata ?? {}),
      lastWatchedUrl: event.sourceUrl,
      lastWatchedAt: event.observedAt,
      lastEpisode: event.episode,
      ...(event.currentTimeSeconds !== undefined ? { lastPositionSeconds: event.currentTimeSeconds } : {}),
      ...(event.durationSeconds !== undefined ? { lastDurationSeconds: event.durationSeconds } : {}),
    },
  };
}
