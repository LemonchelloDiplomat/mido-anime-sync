import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4, AnimeStatus } from "../core/types.js";

interface AniListApiEntry {
  id: number;
  status: string;
  score: number;
  progress: number;
  repeat: number;
  notes?: string | null;
  updatedAt: number;
  startedAt?: { year?: number | null; month?: number | null; day?: number | null } | null;
  completedAt?: { year?: number | null; month?: number | null; day?: number | null } | null;
  media: {
    id: number;
    idMal: number | null;
    title: { romaji: string | null; english: string | null; native: string | null };
    synonyms?: string[];
    format?: string | null;
    status?: string | null;
    episodes?: number | null;
    seasonYear?: number | null;
    startDate?: { year?: number | null; month?: number | null; day?: number | null };
    averageScore?: number | null;
    meanScore?: number | null;
    popularity?: number | null;
    favourites?: number | null;
    description?: string | null;
    endDate?: { year?: number | null; month?: number | null; day?: number | null };
    season?: string | null;
    duration?: number | null;
    countryOfOrigin?: string | null;
    source?: string | null;
    bannerImage?: string | null;
    isAdult?: boolean;
    tags?: Array<{ name: string; rank: number; isGeneralSpoiler: boolean; isAdultSpoiler: boolean; category: string }>;
    studios?: { nodes?: Array<{ id: number; name: string; isAnimationStudio: boolean }> };
    staff?: { edges?: Array<{ role: string; node: { id: number; name: { full: string } } }> };
    genres?: string[];
    isFavourite?: boolean;
    coverImage?: { extraLarge?: string | null; large?: string | null };
  };
}

export type AniListScoreFormat = "POINT_100" | "POINT_10" | "POINT_10_DECIMAL" | "POINT_5" | "POINT_3";

function mapStatus(value: string): AnimeStatus {
  switch (value) {
    case "CURRENT": return "WATCHING";
    case "COMPLETED": return "COMPLETED";
    case "PAUSED": return "ON_HOLD";
    case "DROPPED": return "DROPPED";
    case "PLANNING": return "PLANNING";
    case "REPEATING": return "REWATCHING";
    default: throw new Error("AniList вернул неизвестный статус: " + value);
  }
}

function normalizeScore(score: number, format: AniListScoreFormat): number | null {
  if (!Number.isFinite(score) || score <= 0) return null;
  switch (format) {
    case "POINT_100": return score;
    case "POINT_10":
    case "POINT_10_DECIMAL": return score * 10;
    case "POINT_5": return score * 20;
    case "POINT_3": return (score / 3) * 100;
    default: return null;
  }
}

function formatDate(value?: AniListApiEntry["startedAt"] | null): string | null {
  if (!value?.year || !value.month || !value.day) return null;
  return String(value.year) + "-" + String(value.month).padStart(2, "0") + "-" + String(value.day).padStart(2, "0");
}

function mapFormat(value?: string | null): AnimeIdentity["format"] {
  switch (value) {
    case "TV": return "TV";
    case "TV_SHORT": return "TV_SHORT";
    case "MOVIE": return "MOVIE";
    case "OVA": return "OVA";
    case "ONA": return "ONA";
    case "SPECIAL": return "SPECIAL";
    case "TV_SPECIAL": return "TV_SPECIAL";
    case "CM": return "CM";
    case "PV": return "PV";
    case "MUSIC": return "MUSIC";
    default: return undefined;
  }
}

function mapPartialDate(value?: { year?: number | null; month?: number | null; day?: number | null } | null) {
  if (!value?.year) return null;
  return {
    year: value.year,
    ...(value.month ? { month: value.month } : {}),
    ...(value.day ? { day: value.day } : {}),
  };
}

function mapReleaseStatus(value?: string | null): AnimeIdentity["releaseStatus"] {
  switch (value) {
    case "RELEASING": return "ONGOING";
    case "NOT_YET_RELEASED": return "ANNOUNCED";
    case "FINISHED": return "RELEASED";
    default: return undefined;
  }
}

export function parseAniListAccountList(
  input: unknown,
  scoreFormat: AniListScoreFormat,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  if (!Array.isArray(input)) throw new Error("AniList вернул список в неожиданном формате.");
  const anime: AnimeIdentity[] = [];
  const entries: AnimeListEntry[] = [];
  const seen = new Set<number>();

  for (const raw of input as AniListApiEntry[]) {
    if (!raw?.media || !Number.isSafeInteger(raw.media.id) || raw.media.id <= 0) {
      throw new Error("В списке AniList обнаружена некорректная запись.");
    }
    if (seen.has(raw.media.id)) throw new Error("AniList вернул повторяющийся ID: " + raw.media.id);
    seen.add(raw.media.id);

    const media = raw.media;
    const id = "anilist:" + media.id;
    const startDate = formatDate(media.startDate);
    const endDate = formatDate(media.endDate);
    const startDateParts = mapPartialDate(media.startDate);
    const endDateParts = mapPartialDate(media.endDate);
    const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
      ? new Date(raw.updatedAt * 1000).toISOString()
      : exportedAt;
    const identity: AnimeIdentity = {
      id,
      titles: {
        ...(media.title.romaji ? { romaji: media.title.romaji } : {}),
        ...(media.title.english ? { english: media.title.english } : {}),
        ...(media.title.native ? { native: media.title.native } : {}),
        synonyms: [...new Set((media.synonyms || []).filter(Boolean))],
      },
      externalIds: {
        anilist: String(media.id),
        ...(media.idMal != null ? { myanimelist: String(media.idMal) } : {}),
      },
      ...(startDate ? { startDate } : {}),
      year: media.startDate?.year ?? media.seasonYear ?? null,
      ...(mapFormat(media.format) ? { format: mapFormat(media.format)! } : {}),
      episodes: media.episodes ?? null,
      genres: media.genres || [],
      posterUrl: media.coverImage?.extraLarge || media.coverImage?.large || null,
      averageScore: media.averageScore == null ? null : media.averageScore / 10,
      ...(endDate ? { endDate } : {}),
      ...(startDateParts ? { startDateParts } : {}),
      ...(endDateParts ? { endDateParts } : {}),
      ...(media.season ? { season: media.season as "WINTER" | "SPRING" | "SUMMER" | "FALL" } : {}),
      ...(media.seasonYear ? { seasonYear: media.seasonYear } : {}),
      ...(media.duration != null ? { durationMinutes: media.duration } : {}),
      ...(media.countryOfOrigin ? { countryOfOrigin: media.countryOfOrigin } : {}),
      ...(media.source ? { sourceMaterial: media.source } : {}),
      ...(media.description ? { synopsis: media.description } : {}),
      ...(media.bannerImage ? { bannerUrl: media.bannerImage } : {}),
      tags: (media.tags ?? []).map((tag) => ({
        name: tag.name,
        category: tag.category,
        rank: tag.rank,
        isSpoiler: Boolean(tag.isGeneralSpoiler || tag.isAdultSpoiler),
        isAdult: Boolean(tag.isAdultSpoiler),
      })),
      studios: (media.studios?.nodes ?? []).map((studio) => ({
        name: studio.name,
        externalId: String(studio.id),
        role: studio.isAnimationStudio ? "animation" : "production",
      })),
      staff: (media.staff?.edges ?? []).map((edge) => ({
        name: edge.node.name.full,
        externalId: String(edge.node.id),
        role: edge.role,
      })),
      providerScores: {
        anilist: {
          ...(media.averageScore != null ? { averageScore: {
            value: media.averageScore, scale: 100, normalizedValue: media.averageScore, kind: "average" as const,
          } } : {}),
          ...(media.meanScore != null ? { meanScore: {
            value: media.meanScore, scale: 100, normalizedValue: media.meanScore, kind: "mean" as const,
          } } : {}),
          ...(media.popularity != null ? { popularity: media.popularity } : {}),
          ...(media.favourites != null ? { favorites: media.favourites } : {}),
        },
      },
      providerMetadata: {
        anilist: {
          popularity: media.popularity ?? null,
          favourites: media.favourites ?? null,
          isAdult: media.isAdult ?? null,
        },
      },
      ...(mapReleaseStatus(media.status) ? { releaseStatus: mapReleaseStatus(media.status)! } : {}),
    };
    const entry: AnimeListEntry = {
      animeId: id,
      status: mapStatus(raw.status),
      progress: Math.max(0, Number(raw.progress) || 0),
      score: normalizeScore(Number(raw.score), scoreFormat),
      favorite: Boolean(media.isFavourite),
      updatedAt,
      source: "anilist",
      sharedMetadata: {
        rewatchCount: Math.max(0, Number(raw.repeat) || 0),
        // Null is meaningful: it distinguishes an explicitly empty provider date
        // from metadata that was never present in an older local snapshot.
        startedAt: formatDate(raw.startedAt),
        completedAt: formatDate(raw.completedAt),
      },
      sourceMetadata: {
        anilistEntryId: raw.id,
        repeat: raw.repeat ?? 0,
        notes: raw.notes ?? "",
        scoreFormat,
        startedAt: formatDate(raw.startedAt),
        completedAt: formatDate(raw.completedAt),
      },
    };
    anime.push(identity);
    entries.push(entry);
  }

  return {
    schemaVersion: 4,
    exportedAt,
    anime,
    entries,
    sourceEntries: structuredClone(entries),
    conflictResolutions: [],
    animeRelations: [],
  };
}
