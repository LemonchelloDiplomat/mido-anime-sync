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
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
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

function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = detectDelimiter(firstLine);
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

function stableTitleId(title: string): string {
  let hash = 2166136261;
  for (const character of title.toLocaleLowerCase("ru").replace(/ё/g, "е").trim()) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createRows(
  records: Array<{ id?: string; title: string; original?: string; alternatives?: string; status: string; score?: string; favorite?: string }>,
  hasScoreColumn: boolean,
  hasFavoriteColumn: boolean,
  now: string,
): { anime: AnimeIdentity[]; sourceEntries: AnimeListEntry[]; skipped: number } {
  const anime: AnimeIdentity[] = [];
  const sourceEntries: AnimeListEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const record of records) {
    const title = record.title.trim();
    const status = statusFrom(record.status);
    if (!title || title.length > 300 || !status) { skipped += 1; continue; }
    const externalId = String(record.id || "").trim();
    const hasExactId = /^\d+$/.test(externalId);
    const identityId = hasExactId ? "anixart:" + externalId : "anixart:export:" + stableTitleId(title);
    if (seen.has(identityId)) { skipped += 1; continue; }
    seen.add(identityId);
    const original = String(record.original || "").trim().slice(0, 300);
    const alternatives = String(record.alternatives || "").split(/[;|]/).map((value) => value.trim()).filter(Boolean).slice(0, 20);
    const scoreText = String(record.score ?? "").trim();
    const favoriteText = String(record.favorite ?? "").trim();
    const scoreKnown = hasScoreColumn && scoreText.length > 0;
    const favoriteKnown = hasFavoriteColumn && favoriteText.length > 0;
    const score = scoreKnown ? parseScore(scoreText) : null;
    const identity: AnimeIdentity = {
      id: identityId,
      titles: { romaji: title, synonyms: [...new Set([original, ...alternatives].filter((value) => value && value !== title))] },
      externalIds: hasExactId ? { anixart: externalId } : {},
    };
    const entry: AnimeListEntry = {
      animeId: identityId,
      status,
      progress: 0,
      score,
      favorite: favoriteKnown ? parseBoolean(favoriteText) : false,
      updatedAt: now,
      source: "anixart",
      sourceMetadata: {
        progressKnown: false,
        scoreKnown,
        favoriteKnown,
        importedFrom: "official-export",
      },
    };
    anime.push(identity);
    sourceEntries.push(entry);
  }
  return { anime, sourceEntries, skipped };
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

  let records: Array<{ id?: string; title: string; original?: string; alternatives?: string; status: string; score?: string; favorite?: string }> = [];
  let hasScoreColumn = false;
  let hasFavoriteColumn = false;

  if (/\.csv$/i.test(fileName)) {
    const rows = parseCsv(cleanText);
    if (rows.length < 2) throw new Error("CSV Anixart должен содержать заголовок и хотя бы одну строку.");
    const headers = rows[0]!;
    const titleIndex = findColumn(headers, ["Название", "Название аниме", "Аниме", "Title", "Anime", "Name", "Релиз"]);
    const statusIndex = findColumn(headers, ["Статус просмотра", "Статус", "Watch status", "Status", "Список"]);
    if (titleIndex < 0 || statusIndex < 0) {
      throw new Error("Не удалось распознать столбцы названия и статуса в CSV Anixart. Включи в экспорте «Статус просмотра» и пришли пример файла.");
    }
    const idIndex = findColumn(headers, ["ID", "Идентификатор", "Release ID", "ID релиза"]);
    const originalIndex = findColumn(headers, ["Оригинальное название", "Оригинал", "Original title", "Original"]);
    const alternativesIndex = findColumn(headers, ["Альтернативные названия", "Альтернативное название", "Alternative titles", "Synonyms"]);
    const scoreIndex = findColumn(headers, ["Моя оценка", "Оценка", "Личная оценка", "My score", "Score", "Rating"]);
    const favoriteIndex = findColumn(headers, ["Избранное", "Favorite", "Is favorite"]);
    hasScoreColumn = scoreIndex >= 0;
    hasFavoriteColumn = favoriteIndex >= 0;
    records = rows.slice(1).map((row) => ({
      ...(idIndex >= 0 ? { id: row[idIndex] || "" } : {}),
      title: row[titleIndex] || "",
      ...(originalIndex >= 0 ? { original: row[originalIndex] || "" } : {}),
      ...(alternativesIndex >= 0 ? { alternatives: row[alternativesIndex] || "" } : {}),
      status: row[statusIndex] || "",
      ...(scoreIndex >= 0 ? { score: row[scoreIndex] || "" } : {}),
      ...(favoriteIndex >= 0 ? { favorite: row[favoriteIndex] || "" } : {}),
    }));
  } else {
    records = cleanText.split(/\r?\n/).map((line) => {
      const parts = line.split("/");
      if (parts.length < 7) return { title: "", status: "" };
      return {
        title: parts[1]!.trim().replace(/^["']|["']$/g, ""),
        original: parts[2]!.trim().replace(/^["']|["']$/g, ""),
        status: parts[5]!.trim(),
        score: parts[6]!.trim(),
      };
    });
    hasScoreColumn = true;
  }

  const normalized = createRows(records, hasScoreColumn, hasFavoriteColumn, now);
  if (!normalized.anime.length) {
    throw new Error("В экспорте Anixart не найдено записей с распознанными статусами. Проверь, что выбраны списки просмотра, а не только избранное.");
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
