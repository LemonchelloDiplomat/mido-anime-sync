import type { AnimeAgeRating, AnimeFormat, AnimeIdentity, AnimeListEntry, AnimeSnapshotV4, AnimeStatus } from "../core/types.js";

interface MalApiEntry {
  node: {
    id: number;
    title: string;
    main_picture?: { large?: string; medium?: string };
    alternative_titles?: { en?: string; ja?: string; synonyms?: string[] };
    start_date?: string;
    media_type?: string;
    status?: string;
    num_episodes?: number;
    mean?: number;
    genres?: Array<{ id: number; name: string }>;
    rating?: string;
    end_date?: string;
    start_season?: { season?: string; year?: number };
    broadcast?: { day_of_the_week?: string; start_time?: string };
    rank?: number;
    popularity?: number;
    num_list_users?: number;
    num_scoring_users?: number;
    themes?: Array<{ id: number; name: string }>;
    demographics?: Array<{ id: number; name: string }>;
    studios?: Array<{ id: number; name: string }>;
    producers?: Array<{ id: number; name: string }>;
    licensors?: Array<{ id: number; name: string }>;
    source?: string;
    synopsis?: string;
    background?: string;
  };
  list_status: {
    status: string;
    score: number;
    num_episodes_watched: number;
    is_rewatching?: boolean;
    updated_at?: string;
    num_times_rewatched?: number;
    rewatch_value?: number;
    tags?: string[];
    comments?: string;
    priority?: number;
    start_date?: string;
    finish_date?: string;
  };
}

function mapFormat(value?: string): AnimeFormat | undefined {
  switch (value) {
    case "tv": return "TV";
    case "tv_short": return "TV_SHORT";
    case "tv_special": return "TV_SPECIAL";
    case "cm": return "CM";
    case "pv": return "PV";
    case "movie": return "MOVIE";
    case "ova": return "OVA";
    case "special": return "SPECIAL";
    case "ona": return "ONA";
    case "music": return "MUSIC";
    default: return undefined;
  }
}

function mapReleaseStatus(value?: string): AnimeIdentity["releaseStatus"] {
  switch (value) {
    case "currently_airing": return "ONGOING";
    case "not_yet_aired": return "ANNOUNCED";
    case "finished_airing": return "RELEASED";
    default: return undefined;
  }
}

function mapAgeRating(value?: string): AnimeAgeRating | undefined {
  switch (value) {
    case "g": return "G";
    case "pg": return "PG";
    case "pg_13": return "PG13";
    case "r": return "R17";
    case "r+": return "R+";
    case "rx": return "RX";
    default: return undefined;
  }
}

function mapStatus(value: string, rewatching: boolean): AnimeStatus {
  if (rewatching && value === "watching") return "REWATCHING";
  switch (value) {
    case "watching": return "WATCHING";
    case "completed": return "COMPLETED";
    case "on_hold": return "ON_HOLD";
    case "dropped": return "DROPPED";
    case "plan_to_watch": return "PLANNING";
    default: throw new Error("MyAnimeList вернул неизвестный статус: " + value);
  }
}

function safeDate(value?: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value.slice(0, 10);
}

export function parseMyAnimeListApiList(
  input: unknown,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  if (!Array.isArray(input)) throw new Error("MyAnimeList вернул список в неожиданном формате.");
  const anime: AnimeIdentity[] = [];
  const entries: AnimeListEntry[] = [];
  const seen = new Set<number>();

  for (const raw of input as MalApiEntry[]) {
    if (!raw?.node || !raw.list_status || !Number.isSafeInteger(raw.node.id) || raw.node.id <= 0 || !raw.node.title) {
      throw new Error("В списке MyAnimeList обнаружена некорректная запись.");
    }
    if (seen.has(raw.node.id)) throw new Error("MyAnimeList вернул повторяющийся ID: " + raw.node.id);
    seen.add(raw.node.id);

    const node = raw.node;
    const list = raw.list_status;
    const id = "mal:" + node.id;
    const startDate = safeDate(node.start_date);
    const updatedAt = list.updated_at && !Number.isNaN(Date.parse(list.updated_at))
      ? new Date(list.updated_at).toISOString()
      : exportedAt;
    const identity: AnimeIdentity = {
      id,
      titles: {
        romaji: node.title,
        ...(node.alternative_titles?.en ? { english: node.alternative_titles.en } : {}),
        ...(node.alternative_titles?.ja ? { native: node.alternative_titles.ja } : {}),
        synonyms: [...new Set((node.alternative_titles?.synonyms || []).filter(Boolean))],
      },
      externalIds: { myanimelist: String(node.id) },
      ...(startDate ? { startDate, year: Number(startDate.slice(0, 4)) } : {}),
      ...(node.start_date ? { startDateParts: {
        year: Number(node.start_date.slice(0, 4)),
        ...(node.start_date.length >= 7 ? { month: Number(node.start_date.slice(5, 7)) } : {}),
        ...(node.start_date.length >= 10 ? { day: Number(node.start_date.slice(8, 10)) } : {}),
      } } : {}),
      ...(mapFormat(node.media_type) ? { format: mapFormat(node.media_type)! } : {}),
      ...(Number.isInteger(node.num_episodes) ? { episodes: node.num_episodes } : {}),
      ...(node.genres ? { genres: node.genres.map((genre) => genre.name).filter(Boolean) } : {}),
      posterUrl: node.main_picture?.large || node.main_picture?.medium || null,
      averageScore: typeof node.mean === "number" ? node.mean : null,
      endDate: safeDate(node.end_date),
      ...(node.end_date ? { endDateParts: {
        year: Number(node.end_date.slice(0, 4)),
        ...(node.end_date.length >= 7 ? { month: Number(node.end_date.slice(5, 7)) } : {}),
        ...(node.end_date.length >= 10 ? { day: Number(node.end_date.slice(8, 10)) } : {}),
      } } : {}),
      season: node.start_season?.season ? ({
        winter: "WINTER", spring: "SPRING", summer: "SUMMER", fall: "FALL",
      } as const)[node.start_season.season as "winter" | "spring" | "summer" | "fall"] ?? null : null,
      seasonYear: Number.isInteger(node.start_season?.year) ? node.start_season!.year! : null,
      sourceMaterial: node.source ?? null,
      synopsis: node.synopsis ?? null,
      background: node.background ?? null,
      themes: (node.themes ?? []).map((item) => item.name).filter(Boolean),
      demographics: (node.demographics ?? []).map((item) => item.name).filter(Boolean),
      studios: (node.studios ?? []).map((item) => ({ name: item.name, externalId: String(item.id) })),
      producers: (node.producers ?? []).map((item) => ({ name: item.name, externalId: String(item.id) })),
      licensors: (node.licensors ?? []).map((item) => ({ name: item.name, externalId: String(item.id) })),
      providerScores: {
        myanimelist: {
          ...(typeof node.mean === "number" ? { meanScore: {
            value: node.mean, scale: 10, normalizedValue: Math.round(node.mean * 1000) / 100, kind: "mean" as const,
            voteCount: Number.isSafeInteger(node.num_scoring_users) ? node.num_scoring_users : null,
          } } : {}),
          ...(Number.isSafeInteger(node.rank) ? { rank: node.rank } : {}),
          ...(Number.isSafeInteger(node.popularity) ? { popularity: node.popularity } : {}),
          ...(Number.isSafeInteger(node.num_list_users) ? { members: node.num_list_users } : {}),
        },
      },
      providerMetadata: {
        myanimelist: {
          rating: node.rating ?? null,
          broadcast: node.broadcast ?? null,
          startSeason: node.start_season ?? null,
          source: node.source ?? null,
          numScoringUsers: node.num_scoring_users ?? null,
          numListUsers: node.num_list_users ?? null,
          genres: node.genres ?? [],
          themes: node.themes ?? [],
          demographics: node.demographics ?? [],
          studios: node.studios ?? [],
          producers: node.producers ?? [],
          licensors: node.licensors ?? [],
          raw: node,
        },
      },
      ...(mapAgeRating(node.rating) ? { ageRating: mapAgeRating(node.rating)! } : {}),
      ...(mapReleaseStatus(node.status) ? { releaseStatus: mapReleaseStatus(node.status)! } : {}),
    };
    const entry: AnimeListEntry = {
      animeId: id,
      status: mapStatus(list.status, Boolean(list.is_rewatching)),
      progress: Math.max(0, Number(list.num_episodes_watched) || 0),
      score: list.score > 0 ? list.score * 10 : null,
      favorite: false,
      updatedAt,
      source: "myanimelist",
      sharedMetadata: {
        rewatchCount: Math.max(0, Number(list.num_times_rewatched) || 0),
        ...(safeDate(list.start_date) ? { startedAt: safeDate(list.start_date) } : {}),
        ...(safeDate(list.finish_date) ? { completedAt: safeDate(list.finish_date) } : {}),
      },
      sourceMetadata: {
        originalStatus: list.status,
        originalScore: list.score,
        isRewatching: Boolean(list.is_rewatching),
        timesRewatched: list.num_times_rewatched ?? 0,
        rewatchValue: list.rewatch_value ?? 0,
        tags: list.tags ?? [],
        comments: list.comments ?? "",
        priority: list.priority ?? 0,
        startDate: list.start_date ?? null,
        finishDate: list.finish_date ?? null,
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
