import type {
  AnimeFormat,
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  AnimeStatus,
} from "../core/types.js";

interface ShikimoriAnimeTarget {
  id: number;
  name: string;
  russian?: string | null;
  kind?: string | null;
  episodes?: number | null;
  score?: number | null;
  aired_on?: string | null;
  image?: {
    original?: string | null;
    preview?: string | null;
    x96?: string | null;
  } | null;
}

interface ShikimoriAnimeRate {
  id: number;
  target_id: number;
  target_type?: string;
  status: string;
  score?: number | null;
  episodes?: number | null;
  rewatches?: number | null;
  text?: string | null;
  updated_at?: string | null;
  target: ShikimoriAnimeTarget;
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
    if (
      !raw ||
      !Number.isSafeInteger(raw.id) ||
      raw.id <= 0 ||
      !Number.isSafeInteger(raw.target_id) ||
      raw.target_id <= 0 ||
      !raw.target ||
      raw.target.id !== raw.target_id ||
      !raw.target.name ||
      (raw.target_type !== undefined && raw.target_type !== "Anime")
    ) {
      throw new Error("В списке Shikimori обнаружена некорректная запись.");
    }
    if (seenRateIds.has(raw.id)) throw new Error("Shikimori вернул повторяющийся ID записи: " + raw.id);
    if (seenAnimeIds.has(raw.target_id)) throw new Error("Shikimori вернул повторяющийся ID аниме: " + raw.target_id);
    seenRateIds.add(raw.id);
    seenAnimeIds.add(raw.target_id);

    const id = "shikimori:" + raw.target_id;
    const airedOn = safeDate(raw.target.aired_on);
    const updatedAt = raw.updated_at && Number.isFinite(Date.parse(raw.updated_at))
      ? new Date(raw.updated_at).toISOString()
      : exportedAt;
    const identity: AnimeIdentity = {
      id,
      titles: {
        romaji: raw.target.name,
        synonyms: raw.target.russian ? [raw.target.russian] : [],
      },
      externalIds: { shikimori: String(raw.target_id) },
      ...(airedOn ? { startDate: airedOn, year: Number(airedOn.slice(0, 4)) } : {}),
      ...(mapFormat(raw.target.kind) ? { format: mapFormat(raw.target.kind)! } : {}),
      episodes: typeof raw.target.episodes === "number" && Number.isInteger(raw.target.episodes) ? raw.target.episodes : null,
      averageScore: typeof raw.target.score === "number" ? raw.target.score : null,
      posterUrl: normalizePoster(raw.target.image?.original || raw.target.image?.preview || raw.target.image?.x96),
    };
    const entry: AnimeListEntry = {
      animeId: id,
      status: mapStatus(raw.status),
      progress: Math.max(0, Number(raw.episodes) || 0),
      score: Number(raw.score) > 0 ? Number(raw.score) * 10 : null,
      favorite: false,
      updatedAt,
      source: "shikimori",
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
