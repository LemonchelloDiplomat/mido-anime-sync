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
  myanimelist_id?: number | null;
  russian?: string | null;
  kind?: string | null;
  episodes?: number | null;
  score?: number | string | null;
  aired_on?: string | null;
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
    case "tv": return "TV";
    case "movie": return "MOVIE";
    case "ova": return "OVA";
    case "ona": return "ONA";
    case "special": return "SPECIAL";
    case "music": return "MUSIC";
    default: return undefined;
  }
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
    const identity: AnimeIdentity = {
      id,
      titles: {
        romaji: animeData.name,
        synonyms: animeData.russian ? [animeData.russian] : [],
      },
      externalIds: {
        shikimori: String(animeData.id),
        ...(Number.isSafeInteger(animeData.myanimelist_id) && Number(animeData.myanimelist_id) > 0
          ? { myanimelist: String(animeData.myanimelist_id) }
          : {}),
      },
      ...(airedOn ? { startDate: airedOn, year: Number(airedOn.slice(0, 4)) } : {}),
      ...(mapFormat(animeData.kind) ? { format: mapFormat(animeData.kind)! } : {}),
      episodes: typeof animeData.episodes === "number" && Number.isInteger(animeData.episodes)
        ? animeData.episodes
        : null,
      averageScore,
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
