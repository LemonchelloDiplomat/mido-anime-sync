import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";
import { mergeAnimeMetadata } from "../core/anime-metadata.js";

export interface AnimeGoAccountRawEntry {
  animeId: string;
  title: string;
  originalTitle?: string | null;
  posterUrl?: string | null;
  score?: number | string | null;
  href?: string | null;
  episodesWatched?: number | null;
  episodesTotal?: number | null;
}

export interface AnimeGoAccountListPayload {
  listType: number;
  sourceUrl: string;
  entries: unknown[];
}

/** Keep native fetch timestamps compatible with the snapshot ISO-8601 contract. */
export function normalizeAnimeGoFetchedAt(value: unknown, now = new Date()): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return now.toISOString();
}

export interface NormalizedAnimeGoAccountList {
  status: AnimeStatus;
  rows: Array<{ anime: AnimeIdentity; entry: AnimeListEntry }>;
  skipped: number;
}

const STATUS_BY_LIST_TYPE: Record<number, AnimeStatus> = {
  1: "WATCHING",
  2: "COMPLETED",
  3: "ON_HOLD",
  4: "DROPPED",
  5: "PLANNING",
  6: "REWATCHING",
};

function safeAnimeGoProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:") &&
      (host === "animego.me" || host.endsWith(".animego.me") ||
        host === "anime-go.org" || host.endsWith(".anime-go.org") ||
        host === "animego.online" || host.endsWith(".animego.online")) &&
      /^\/(?:profile|user)\//.test(url.pathname);
  } catch {
    return false;
  }
}

/** Normalize a single user-selected AnimeGO profile list. No remote writes or deletes occur. */
export function mergeAnimeGoTitleMetadata(
  current: AnimeIdentity,
  incoming: AnimeIdentity,
): AnimeIdentity {
  const isUsablePoster = (value: string | null | undefined): value is string => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") && url.pathname.length > 1;
    } catch {
      return false;
    }
  };
  const currentPoster = isUsablePoster(current.posterUrl) ? current.posterUrl : null;
  const incomingPoster = isUsablePoster(incoming.posterUrl) ? incoming.posterUrl : null;
  return {
    ...mergeAnimeMetadata(current, incoming),
    titles: {
      ...incoming.titles,
      ...current.titles,
      synonyms: [...new Set([...(incoming.titles.synonyms ?? []), ...(current.titles.synonyms ?? [])])],
    },
    externalIds: { ...incoming.externalIds, ...current.externalIds },
    year: current.year ?? incoming.year ?? null,
    ...((current.format ?? incoming.format) ? { format: current.format ?? incoming.format! } : {}),
    episodes: current.episodes ?? incoming.episodes ?? null,
    genres: current.genres?.length ? current.genres : (incoming.genres ?? []),
    ageRating: current.ageRating ?? incoming.ageRating ?? null,
    posterUrl: currentPoster ?? incomingPoster,
    averageScore: current.averageScore ?? incoming.averageScore ?? null,
    startDate: current.startDate ?? incoming.startDate ?? null,
    ...((current.releaseStatus ?? incoming.releaseStatus) ? { releaseStatus: current.releaseStatus ?? incoming.releaseStatus! } : {}),
  };
}

export function normalizeAnimeGoAccountList(
  payload: AnimeGoAccountListPayload,
  now = new Date().toISOString(),
): NormalizedAnimeGoAccountList {
  const status = STATUS_BY_LIST_TYPE[payload.listType];
  if (!status) throw new Error("Неизвестный тип списка AnimeGO.");
  if (!safeAnimeGoProfileUrl(payload.sourceUrl)) {
    throw new Error("Импорт AnimeGO разрешён только со страницы собственного профиля или списка пользователя.");
  }
  if (!Array.isArray(payload.entries) || payload.entries.length > 5000) {
    throw new Error("AnimeGO вернул некорректный размер списка (максимум 5000 записей за импорт).");
  }

  const rows: NormalizedAnimeGoAccountList["rows"] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of payload.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skipped += 1;
      continue;
    }
    const raw = value as Partial<AnimeGoAccountRawEntry>;
    const animeId = String(raw.animeId ?? "").trim();
    const title = String(raw.title ?? "").trim();
    if (!/^\d+$/.test(animeId) || !title || title.length > 300 || seen.has(animeId)) {
      skipped += 1;
      continue;
    }
    seen.add(animeId);
    const originalTitle = typeof raw.originalTitle === "string" ? raw.originalTitle.trim().slice(0, 300) : "";
    const scoreValue = raw.score == null || raw.score === "" ? null : Number(raw.score);
    const scoreKnown = scoreValue !== null && Number.isFinite(scoreValue) && scoreValue >= 1 && scoreValue <= 10;
    const posterUrl = typeof raw.posterUrl === "string" && /^https:\/\//i.test(raw.posterUrl)
      ? raw.posterUrl.slice(0, 2048)
      : null;
    const progressKnown = typeof raw.episodesWatched === "number" &&
      Number.isSafeInteger(raw.episodesWatched) && raw.episodesWatched >= 0;
    const episodesTotal = typeof raw.episodesTotal === "number" &&
      Number.isSafeInteger(raw.episodesTotal) && raw.episodesTotal >= 0
      ? raw.episodesTotal : null;
    const anime: AnimeIdentity = {
      id: "animego:" + animeId,
      titles: { romaji: title, synonyms: originalTitle && originalTitle !== title ? [originalTitle] : [] },
      externalIds: { animego: animeId },
      ...(episodesTotal !== null ? { episodes: episodesTotal } : {}),
      posterUrl,
    };
    const entry: AnimeListEntry = {
      animeId: anime.id,
      status,
      progress: progressKnown ? raw.episodesWatched! : 0,
      score: scoreKnown ? Math.round(scoreValue! * 10) : null,
      favorite: false,
      updatedAt: now,
      source: "animego",
      sourceMetadata: {
        listType: payload.listType,
        progressKnown,
        episodesTotal,
        scoreKnown,
        originalScore: raw.score ?? null,
        scoreScale: 10,
        favoriteKnown: false,
      },
    };
    rows.push({ anime, entry });
  }
  return { status, rows, skipped };
}
