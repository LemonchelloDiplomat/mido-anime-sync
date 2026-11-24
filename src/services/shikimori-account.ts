import type {
  AnimeFormat,
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  AnimeStatus,
} from "../core/types.js";

interface ShikimoriAnime {
  id: number;
  name: string;
  myanimelist_id?: number | string | null;
  mal_id?: number | string | null;
  malId?: number | string | null;
  russian?: string | null;
  english?: string | null;
  japanese?: string | null;
  synonyms?: string[];
  kind?: string | null;
  status?: string | null;
  episodes?: number | null;
  episodes_aired?: number | null;
  duration?: number | null;
  score?: number | string | null;
  rating?: string | null;
  origin?: string | null;
  season?: string | null;
  franchise?: string | null;
  is_censored?: boolean | null;
  aired_on?: string | null;
  aired_on_parts?: { year?: number | null; month?: number | null; day?: number | null } | null;
  released_on?: string | null;
  released_on_parts?: { year?: number | null; month?: number | null; day?: number | null } | null;
  description?: string | null;
  description_html?: string | null;
  genres?: Array<{ id?: number; name?: string; russian?: string; kind?: string }>;
  studios?: Array<{ id?: number; name?: string }>;
  licensors?: string[];
  opengraph_image_url?: string | null;
  image?: {
    original?: string | null;
    preview?: string | null;
    x96?: string | null;
  } | null;
}

interface ShikimoriAnimeRate {
  id: number;
  status: string;
  score?: number | null;
  episodes?: number | null;
  rewatches?: number | null;
  text?: string | null;
  updated_at?: string | null;
  anime: ShikimoriAnime;
}

function mapStatus(value: string): AnimeStatus {
  switch (value) {
    case "watching": return "WATCHING";
    case "rewatching": return "REWATCHING";
    case "completed": return "COMPLETED";
    case "on_hold": return "ON_HOLD";
    case "dropped": return "DROPPED";
    case "planned": return "PLANNING";
    default: throw new Error("Shikimori вернул неизвестный статус: " + value);
  }
}

function mapFormat(value?: string | null): AnimeFormat | undefined {
  switch (value) {
    case "tv":
    case "tv_13":
    case "tv_24": return "TV";
    case "tv_special": return "TV_SPECIAL";
    case "movie": return "MOVIE";
    case "ova": return "OVA";
    case "ona": return "ONA";
    case "special": return "SPECIAL";
    case "music": return "MUSIC";
    case "tv_short": return "TV_SHORT";
    case "cm": return "CM";
    case "pv": return "PV";
    default: return undefined;
  }
}

function mapAgeRating(value?: string | null): AnimeIdentity["ageRating"] {
  switch (value) {
    case "g": return "G";
    case "pg": return "PG";
    case "pg_13": return "PG13";
    case "r": return "R17";
    case "r_plus": return "R+";
    case "rx": return "RX";
    default: return null;
  }
}

function mapReleaseStatus(value?: string | null): AnimeIdentity["releaseStatus"] {
  switch (value) {
    case "ongoing": return "ONGOING";
    case "anons": return "ANNOUNCED";
    case "released": return "RELEASED";
    default: return undefined;
  }
}

function mapSeason(value?: string | null): { season: "WINTER" | "SPRING" | "SUMMER" | "FALL"; year: number } | null {
  const match = /^(winter|spring|summer|fall)_(\d{4})$/i.exec(value ?? "");
  if (!match) return null;
  return {
    season: match[1]!.toUpperCase() as "WINTER" | "SPRING" | "SUMMER" | "FALL",
    year: Number(match[2]),
  };
}

function normalizePoster(value?: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("//")) return "https:" + value;
  if (value.startsWith("/")) return "https://shikimori.io" + value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeDate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : undefined;
}

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMyAnimeListId(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseShikimoriAccountList(
  input: unknown,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  if (!Array.isArray(input)) throw new Error("Shikimori вернул список в неожиданном формате.");

  const anime: AnimeIdentity[] = [];
  const entries: AnimeListEntry[] = [];
  const seenRateIds = new Set<number>();
  const seenAnimeIds = new Set<number>();

  for (const raw of input as ShikimoriAnimeRate[]) {
    const animeData = raw?.anime;
    if (
      !raw ||
      !Number.isSafeInteger(raw.id) ||
      raw.id <= 0 ||
      !animeData ||
      !Number.isSafeInteger(animeData.id) ||
      animeData.id <= 0 ||
      typeof animeData.name !== "string" ||
      !animeData.name.trim() ||
      typeof raw.status !== "string"
    ) {
      throw new Error("В списке Shikimori обнаружена некорректная запись.");
    }
    if (seenRateIds.has(raw.id)) throw new Error("Shikimori вернул повторяющийся ID записи: " + raw.id);
    if (seenAnimeIds.has(animeData.id)) throw new Error("Shikimori вернул повторяющийся ID аниме: " + animeData.id);
    seenRateIds.add(raw.id);
    seenAnimeIds.add(animeData.id);

    const id = "shikimori:" + animeData.id;
    const airedOn = safeDate(animeData.aired_on);
    const updatedAt = raw.updated_at && Number.isFinite(Date.parse(raw.updated_at))
      ? new Date(raw.updated_at).toISOString()
      : exportedAt;
    const averageScore = finiteNumber(animeData.score);
    const myanimelistId = normalizeMyAnimeListId(
      animeData.myanimelist_id ?? animeData.mal_id ?? animeData.malId,
    );
    const season = mapSeason(animeData.season);
    const genreRows = animeData.genres ?? [];
    const identity: AnimeIdentity = {
      id,
      titles: {
        romaji: animeData.name,
        ...(animeData.english ? { english: animeData.english } : {}),
        ...(animeData.japanese ? { native: animeData.japanese } : {}),
        synonyms: [...new Set([...(animeData.synonyms ?? []), ...(animeData.russian ? [animeData.russian] : [])])],
      },
      externalIds: {
        shikimori: String(animeData.id),
        ...(myanimelistId !== null ? { myanimelist: String(myanimelistId) } : {}),
      },
      ...(airedOn ? { startDate: airedOn, year: Number(airedOn.slice(0, 4)) } : {}),
      ...(mapFormat(animeData.kind) ? { format: mapFormat(animeData.kind)! } : {}),
      episodes: typeof animeData.episodes === "number" && Number.isInteger(animeData.episodes)
        ? animeData.episodes
        : null,
      episodesAired: typeof animeData.episodes_aired === "number" ? animeData.episodes_aired : null,
      durationMinutes: typeof animeData.duration === "number" ? animeData.duration : null,
      averageScore,
      ...(mapAgeRating(animeData.rating) ? { ageRating: mapAgeRating(animeData.rating)! } : {}),
      ...(mapReleaseStatus(animeData.status) ? { releaseStatus: mapReleaseStatus(animeData.status)! } : {}),
      ...(animeData.aired_on ? { startDate: airedOn } : {}),
      ...(animeData.released_on ? { endDate: safeDate(animeData.released_on) ?? null } : {}),
      ...(animeData.aired_on_parts?.year ? { startDateParts: animeData.aired_on_parts } : {}),
      ...(animeData.released_on_parts?.year ? { endDateParts: animeData.released_on_parts } : {}),
      ...(season ? { season: season.season, seasonYear: season.year } : {}),
      sourceMaterial: animeData.origin ?? null,
      synopsis: animeData.description ?? null,
      genres: genreRows.filter((genre) => !genre.kind || genre.kind === "genre").map((genre) => genre.russian || genre.name || "").filter(Boolean),
      themes: genreRows.filter((genre) => genre.kind === "theme").map((genre) => genre.russian || genre.name || "").filter(Boolean),
      demographics: genreRows.filter((genre) => genre.kind === "demographic").map((genre) => genre.russian || genre.name || "").filter(Boolean),
      studios: (animeData.studios ?? []).map((studio) => ({
        name: studio.name || "",
        ...(studio.id ? { externalId: String(studio.id) } : {}),
      })).filter((studio) => studio.name),
      licensors: (animeData.licensors ?? []).map((name) => ({ name })),
      bannerUrl: animeData.opengraph_image_url ?? null,
      providerScores: {
        shikimori: {
          ...(averageScore !== null ? { averageScore: {
            value: averageScore, scale: 10, normalizedValue: averageScore * 10, kind: "average" as const,
          } } : {}),
        },
      },
      providerMetadata: {
        shikimori: {
          rating: animeData.rating ?? null,
          status: animeData.status ?? null,
          season: animeData.season ?? null,
          franchise: animeData.franchise ?? null,
          isCensored: animeData.is_censored ?? null,
          descriptionHtml: animeData.description_html ?? null,
        },
      },
      posterUrl: normalizePoster(
        animeData.image?.original || animeData.image?.preview || animeData.image?.x96,
      ),
    };
    const personalScore = finiteNumber(raw.score);
    const entry: AnimeListEntry = {
      animeId: id,
      status: mapStatus(raw.status),
      progress: Math.max(0, finiteNumber(raw.episodes) ?? 0),
      score: personalScore !== null && personalScore > 0 ? personalScore * 10 : null,
      favorite: false,
      updatedAt,
      source: "shikimori",
      sharedMetadata: {
        rewatchCount: Math.max(0, Number(raw.rewatches) || 0),
      },
      sourceMetadata: {
        shikimoriRateId: raw.id,
        originalScore: raw.score ?? 0,
        scoreScale: 10,
        rewatches: raw.rewatches ?? 0,
        text: raw.text ?? "",
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
