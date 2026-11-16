import type {
  AnimeFormat,
  AnimeIdentity,
  AnimeListEntry,
  AnimeSnapshotV4,
  AnimeStatus,
} from "../core/types.js";

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function readTag(block: string, tag: string): string {
  const expression = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,
    "i",
  );
  const match = block.match(expression);
  return match?.[1] ? decodeXml(match[1]) : "";
}

function readFirstTag(block: string, tags: string[]): string {
  for (const tag of tags) {
    const value = readTag(block, tag);
    if (value) return value;
  }
  return "";
}

function readInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mapFormat(value: string): AnimeFormat | undefined {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "tv":
      return "TV";
    case "2":
    case "ova":
      return "OVA";
    case "3":
    case "movie":
      return "MOVIE";
    case "4":
    case "special":
      return "SPECIAL";
    case "5":
    case "ona":
      return "ONA";
    case "6":
    case "music":
      return "MUSIC";
    default:
      return undefined;
  }
}

function mapStatus(value: string): AnimeStatus {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "watching":
      return "WATCHING";
    case "2":
    case "completed":
      return "COMPLETED";
    case "3":
    case "on-hold":
    case "on_hold":
      return "ON_HOLD";
    case "4":
    case "dropped":
      return "DROPPED";
    case "6":
    case "plan to watch":
    case "plan_to_watch":
    case "planned":
      return "PLANNING";
    default:
      throw new Error(`MyAnimeList: неизвестный статус записи "${value}".`);
  }
}

function parseUpdatedAt(value: string, fallback: string): string {
  const raw = value.trim();
  if (!raw) return fallback;

  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(raw);

  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseYear(value: string): number | null {
  const match = value.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

/**
 * Converts a MyAnimeList XML list export into the app's normalized snapshot.
 * The importer is read-only and never calls MyAnimeList.
 */
export function parseMyAnimeListXml(
  xml: string,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  const source = xml.replace(/^\uFEFF/, "").trim();

  if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) {
    throw new Error("MyAnimeList XML: DTD и пользовательские сущности не поддерживаются.");
  }

  if (!/<myanimelist(?:\s[^>]*)?>/i.test(source) || !/<\/myanimelist>/i.test(source)) {
    throw new Error("Это не похоже на XML-экспорт списка MyAnimeList.");
  }

  const openingTags = source.match(/<anime(?:\s[^>]*)?>/gi) ?? [];
  const closingTags = source.match(/<\/anime\s*>/gi) ?? [];
  if (openingTags.length === 0 || openingTags.length !== closingTags.length) {
    throw new Error("MyAnimeList XML: не найдены корректные записи аниме.");
  }

  const blocks = [...source.matchAll(/<anime(?:\s[^>]*)?>([\s\S]*?)<\/anime\s*>/gi)];
  if (blocks.length !== openingTags.length) {
    throw new Error("MyAnimeList XML: файл повреждён или содержит незакрытые записи.");
  }

  const anime: AnimeIdentity[] = [];
  const entries: AnimeListEntry[] = [];
  const seenIds = new Set<string>();

  for (const match of blocks) {
    const block = match[1] ?? "";
    const rawId = readFirstTag(block, ["series_animedb_id", "series_id"]);
    const title = readFirstTag(block, ["series_title", "title"]);
    const id = readInteger(rawId);

    if (id == null || !title) {
      throw new Error("MyAnimeList XML: у одной из записей отсутствует ID или название.");
    }

    const externalId = String(id);
    if (seenIds.has(externalId)) {
      throw new Error(`MyAnimeList XML: повторяется ID аниме ${externalId}. Импорт остановлен для проверки файла.`);
    }
    seenIds.add(externalId);

    const english = readTag(block, "series_title_english");
    const native = readFirstTag(block, ["series_title_japanese", "series_title_native"]);
    const synonyms = readTag(block, "series_synonyms")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    const episodes = readInteger(readTag(block, "series_episodes"));
    const format = mapFormat(readTag(block, "series_type"));
    const image = readFirstTag(block, ["series_image", "series_image_url"]);
    const year = parseYear(readFirstTag(block, [
      "series_start",
      "series_start_date",
      "series_aired",
    ]));
    const globalScore = readInteger(readTag(block, "series_score"));
    const personalScore = readInteger(readTag(block, "my_score"));
    const progress = readInteger(readTag(block, "my_watched_episodes")) ?? 0;
    const status = mapStatus(readTag(block, "my_status"));
    const updatedAt = parseUpdatedAt(readTag(block, "my_last_updated"), exportedAt);
    const timesWatched = readInteger(readTag(block, "my_times_watched")) ?? 0;

    const identity: AnimeIdentity = {
      id: `mal:${externalId}`,
      titles: {
        ...(english ? { english } : {}),
        romaji: title,
        ...(native ? { native } : {}),
        synonyms: [...new Set(synonyms)],
      },
      externalIds: { myanimelist: externalId },
      ...(year != null ? { year } : {}),
      ...(format ? { format } : {}),
      ...(episodes != null ? { episodes } : {}),
      ...(image ? { posterUrl: image } : {}),
      ...(globalScore != null && globalScore > 0 && globalScore <= 10
        ? { averageScore: globalScore }
        : {}),
    };

    const entry: AnimeListEntry = {
      animeId: identity.id,
      status,
      progress,
      score: personalScore != null && personalScore > 0 && personalScore <= 10
        ? personalScore * 10
        : null,
      favorite: false,
      updatedAt,
      source: "myanimelist",
      sourceMetadata: {
        originalStatus: readTag(block, "my_status"),
        originalScore: readTag(block, "my_score"),
        timesWatched,
        startDate: readTag(block, "my_start_date"),
        finishDate: readTag(block, "my_finish_date"),
        tags: readTag(block, "my_tags"),
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
