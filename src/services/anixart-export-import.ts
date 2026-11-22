import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4, AnimeStatus } from "../core/types.js";

export interface AnixartExportImportResult {
  snapshot: AnimeSnapshotV4;
  skipped: number;
}

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
}

function findColumn(headers: string[], aliases: string[]): number {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => normalizedAliases.has(normalizeHeader(header)));
}

function detectDelimiter(line: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0], ["|", 0]]);
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? "";
    if (char === '"') {
      if (quoted && line[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

function parseCsv(text: string, forcedDelimiter?: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = forcedDelimiter ?? detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(field.trim()); field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field.trim()); field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function statusFrom(value: string): AnimeStatus | null {
  const status = normalizeHeader(value);
  if (/^(watching|watch|смотрю|просмотр)$/i.test(status)) return "WATCHING";
  if (/^(completed|complete|watched|просмотрено|завершено)$/i.test(status)) return "COMPLETED";
  if (/^(planned|plantowatch|впланах|запланировано)$/i.test(status)) return "PLANNING";
  if (/^(onhold|hold|отложено|приостановлено)$/i.test(status)) return "ON_HOLD";
  if (/^(dropped|drop|брошено)$/i.test(status)) return "DROPPED";
  if (/^(rewatching|пересматриваю)$/i.test(status)) return "REWATCHING";
  return null;
}

function parseScore(value: string): number | null {
  const normalized = value.trim().toLocaleLowerCase("ru");
  if (!normalized || /не оценено|без оценки|not rated|unrated/i.test(normalized)) return null;
  const match = normalized.replace(",", ".").match(/(?:^|\D)([0-5](?:\.\d+)?)(?:\s*(?:из|\/)\s*5)?(?:$|\D)/i);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) && score > 0 && score <= 5 ? Math.round(score * 20) : null;
}

function parseBoolean(value: string): boolean {
  return /^(1|true|yes|да|избранное|favorite|избран)$/i.test(value.trim());
}

function stableTitleId(identity: string): string {
  const normalized = identity.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
  let first = 2166136261;
  let second = 5381;
  for (const character of normalized) {
    const code = character.codePointAt(0) || 0;
    first ^= code;
    first = Math.imul(first, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return (first >>> 0).toString(16).padStart(8, "0") +
    (second >>> 0).toString(16).padStart(8, "0");
}

type ExportRecord = { id?: string; title: string; original?: string; alternatives?: string; status: string; score?: string; favorite?: string };

function extractReleaseId(value: string): string {
  const text = value.trim();
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/(?:^|\/)(\d+)-[\p{L}\p{N}-]+\.html(?:[?#].*)?$/iu);
  return match?.[1] ?? "";
}

function isFavoriteStatus(value: string): boolean {
  return /^(favorite|favorites|избранное|избран)$/i.test(normalizeHeader(value));
}

function createRows(
  records: ExportRecord[],
  hasScoreColumn: boolean,
  hasFavoriteColumn: boolean,
  now: string,
): { anime: AnimeIdentity[]; sourceEntries: AnimeListEntry[]; skipped: number } {
  const animeById = new Map<string, AnimeIdentity>();
  const entryById = new Map<string, AnimeListEntry>();
  let skipped = 0;

  for (const record of records) {
    const title = record.title.trim();
    const status = statusFrom(record.status);
    const favoriteFromList = isFavoriteStatus(record.status);
    const favoriteText = String(record.favorite ?? "").trim();
    const scoreText = String(record.score ?? "").trim();
    const favoriteKnown = favoriteFromList || (hasFavoriteColumn && favoriteText.length > 0);
    const favorite = favoriteFromList || (favoriteKnown && parseBoolean(favoriteText));

    // Favorites are a separate Anixart collection, not a watch status.
    // Keep them as favorites with an explicitly unknown status rather than
    // silently discarding them or pretending they are planned.
    if (!title || title.length > 300 || (!status && !favorite)) {
      skipped += 1;
      continue;
    }

    const externalId = extractReleaseId(String(record.id || ""));
    const hasExactId = Boolean(externalId);
    const original = String(record.original || "").trim().slice(0, 300);
    const alternatives = String(record.alternatives || "")
      .split(/[;|]/).map((value) => value.trim()).filter(Boolean).slice(0, 20);
    const identityId = hasExactId
      ? "anixart:" + externalId
      : "anixart:export:" + stableTitleId([title, original, ...alternatives].join("|"));
    const scoreKnown = hasScoreColumn && scoreText.length > 0;
    const score = scoreKnown ? parseScore(scoreText) : null;
    const statusKnown = status !== null;

    const identity: AnimeIdentity = {
      id: identityId,
      titles: {
        romaji: title,
        synonyms: [...new Set([original, ...alternatives].filter((value) => value && value !== title))],
      },
      externalIds: hasExactId ? { anixart: externalId } : {},
    };
    const entry: AnimeListEntry = {
      animeId: identityId,
      status: status ?? "PLANNING",
      progress: 0,
      score,
      favorite,
      updatedAt: now,
      source: "anixart",
      sourceMetadata: {
        progressKnown: false,
        statusKnown,
        scoreKnown,
        favoriteKnown,
        importedFrom: "official-export",
      },
    };

    const previousAnime = animeById.get(identityId);
    if (previousAnime) {
      animeById.set(identityId, {
        ...previousAnime,
        titles: {
          ...previousAnime.titles,
          synonyms: [...new Set([...previousAnime.titles.synonyms, ...identity.titles.synonyms])],
        },
        externalIds: { ...previousAnime.externalIds, ...identity.externalIds },
      });
      const previousEntry = entryById.get(identityId)!;
      const previousMetadata = previousEntry.sourceMetadata ?? {};
      const nextMetadata = entry.sourceMetadata ?? {};
      const previousStatusKnown = previousMetadata.statusKnown !== false;
      const previousScoreKnown = previousMetadata.scoreKnown === true;
      const nextScoreKnown = nextMetadata.scoreKnown === true;
      entryById.set(identityId, {
        ...previousEntry,
        status: previousStatusKnown || !statusKnown ? previousEntry.status : status!,
        score: previousScoreKnown || !nextScoreKnown ? previousEntry.score : score,
        favorite: previousEntry.favorite || favorite,
        sourceMetadata: {
          ...previousMetadata,
          statusKnown: previousStatusKnown || statusKnown,
          scoreKnown: previousScoreKnown || nextScoreKnown,
          favoriteKnown: previousMetadata.favoriteKnown === true || favoriteKnown,
          progressKnown: false,
          importedFrom: "official-export",
        },
      });
    } else {
      animeById.set(identityId, identity);
      entryById.set(identityId, entry);
    }
  }

  return { anime: [...animeById.values()], sourceEntries: [...entryById.values()], skipped };
}

/** Parse the user's own Anixart CSV or text export. No Anixart account/API access is performed. */
export function parseAnixartBookmarkExport(
  text: string,
  fileName: string,
  now = new Date().toISOString(),
): AnixartExportImportResult {
  const cleanText = text.replace(/^\uFEFF/, "").trim();
  if (!cleanText) throw new Error("Файл экспорта Anixart пустой.");
  if (cleanText.length > 25 * 1024 * 1024) throw new Error("Файл экспорта Anixart слишком большой.");

  let records: ExportRecord[] = [];
  let hasScoreColumn = false;
  let hasFavoriteColumn = false;

  const firstLine = cleanText.split(/\r?\n/, 1)[0] ?? "";
  const headerCells = parseCsv(firstLine)[0] ?? [];
  const titleHeaderIndex = findColumn(headerCells, [
    "Название", "Название аниме", "Аниме", "Title", "Anime", "Name", "Релиз",
  ]);
  const statusHeaderIndex = findColumn(headerCells, [
    "Статус просмотра", "Статус", "Watch status", "Status", "Список",
  ]);
  const favoriteHeaderIndex = findColumn(headerCells, [
    "Избранное", "Favorite", "Is favorite",
  ]);
  const isDelimitedExport = /\.csv$/i.test(fileName) ||
    (titleHeaderIndex >= 0 && (statusHeaderIndex >= 0 || favoriteHeaderIndex >= 0));

  if (isDelimitedExport) {
    const rows = parseCsv(cleanText);
    if (rows.length < 2) throw new Error("Экспорт Anixart должен содержать заголовок и хотя бы одну строку.");
    const headers = rows[0]!;
    const titleIndex = findColumn(headers, ["Название", "Название аниме", "Аниме", "Title", "Anime", "Name", "Релиз"]);
    const statusIndex = findColumn(headers, ["Статус просмотра", "Статус", "Watch status", "Status", "Список"]);
    const idIndex = findColumn(headers, ["ID", "Идентификатор", "Release ID", "ID релиза", "Ссылка", "Ссылка на релиз", "URL", "Release URL"]);
    const originalIndex = findColumn(headers, ["Оригинальное название", "Оригинал", "Original title", "Original"]);
    const alternativesIndex = findColumn(headers, ["Альтернативные названия", "Альтернативное название", "Alternative titles", "Synonyms"]);
    const scoreIndex = findColumn(headers, ["Моя оценка", "Оценка", "Личная оценка", "My score", "Score", "Rating"]);
    const favoriteIndex = findColumn(headers, ["Избранное", "Favorite", "Is favorite"]);
    if (titleIndex < 0 || (statusIndex < 0 && favoriteIndex < 0)) {
      throw new Error("Не удалось распознать столбцы названия и статуса/избранного в экспорте Anixart. Включи «Статус просмотра» и/или экспорт списка «Избранное».");
    }
    hasScoreColumn = scoreIndex >= 0;
    hasFavoriteColumn = favoriteIndex >= 0;
    records = rows.slice(1).map((row) => ({
      ...(idIndex >= 0 ? { id: row[idIndex] || "" } : {}),
      title: row[titleIndex] || "",
      ...(originalIndex >= 0 ? { original: row[originalIndex] || "" } : {}),
      ...(alternativesIndex >= 0 ? { alternatives: row[alternativesIndex] || "" } : {}),
      status: statusIndex >= 0 ? row[statusIndex] || "" : "",
      ...(scoreIndex >= 0 ? { score: row[scoreIndex] || "" } : {}),
      ...(favoriteIndex >= 0 ? { favorite: row[favoriteIndex] || "" } : {}),
    }));
  } else {
    // Older Anixart text exports use slash-separated records. Parse quotes
    // so a slash inside a title does not shift the remaining columns.
    records = cleanText.split(/\r?\n/).map((line) => {
      const parts = parseCsv(line, "/")[0] ?? [];
      const offset = parts[0] === "" ? 1 : /^\d+$/.test(parts[0] ?? "") && parts.length >= 7 ? 1 : 0;
      if (parts.length < offset + 6) return { title: "", status: "" };
      const first = (value: string | undefined) => (value ?? "").trim().replace(/^["']|["']$/g, "");
      const title = first(parts[offset]);
      return {
        ...(offset === 1 && /^\d+$/.test(parts[0] ?? "") ? { id: first(parts[0]) } : {}),
        title,
        original: first(parts[offset + 1]),
        status: first(parts[offset + 4]),
        score: first(parts[offset + 5]),
      };
    });
    hasScoreColumn = true;
  }

  const normalized = createRows(records, hasScoreColumn, hasFavoriteColumn, now);
  if (!normalized.anime.length) {
    throw new Error("В экспорте Anixart не найдено записей с распознанными статусами или избранным. Проверь выбранные списки и параметры экспорта.");
  }
  const snapshot: AnimeSnapshotV4 = {
    schemaVersion: 4,
    exportedAt: now,
    anime: normalized.anime,
    entries: [],
    sourceEntries: normalized.sourceEntries,
    conflictResolutions: [],
    animeRelations: [],
  };
  return { snapshot, skipped: normalized.skipped };
}
