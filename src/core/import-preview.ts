import type { AnimeIdentity } from "./types.js";
import { findAnimeMatches, type AnimeMatch } from "./matching.js";

export type ImportPreviewStatus = "new" | "matched" | "review";

export interface ImportPreviewItem {
  imported: AnimeIdentity;
  status: ImportPreviewStatus;
  matches: AnimeMatch[];
  selectedMatch: AnimeIdentity | null;
  reason: string;

  // Подозрительное дублирование внутри импортируемого файла.
  duplicateInImport: boolean;
}

export interface ImportPreview {
  items: ImportPreviewItem[];
  summary: {
    total: number;
    new: number;
    matched: number;
    review: number;
  };
}

function getTitles(anime: AnimeIdentity): Set<string> {
  const titles = [
    anime.titles.english,
    anime.titles.romaji,
    anime.titles.native,
    ...anime.titles.synonyms,
  ];

  return new Set(
    titles
      .filter((title): title is string => Boolean(title?.trim()))
      .map((title) =>
        title
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim()
          .replace(/\s+/g, " "),
      )
      .filter(Boolean),
  );
}

function getIdentityConflicts(
  first: AnimeIdentity,
  second: AnimeIdentity,
): string[] {
  const conflicts: string[] = [];

  const firstTitles = getTitles(first);
  const secondTitles = getTitles(second);

  const hasTitles = firstTitles.size > 0 && secondTitles.size > 0;

  const hasSharedTitle = [...firstTitles].some((title) =>
    secondTitles.has(title),
  );

  if (hasTitles && !hasSharedTitle) {
    conflicts.push("Названия различаются");
  }

  if (first.year != null && second.year != null && first.year !== second.year) {
    conflicts.push("Годы выхода различаются");
  }

  if (
    first.format !== undefined &&
    second.format !== undefined &&
    first.format !== second.format
  ) {
    conflicts.push("Форматы различаются");
  }

  if (
    first.episodes != null &&
    second.episodes != null &&
    first.episodes !== second.episodes
  ) {
    conflicts.push("Количество эпизодов различается");
  }

  return conflicts;
}

function createInternalIdMatch(
  imported: AnimeIdentity,
  existing: AnimeIdentity,
): AnimeMatch {
  const conflicts = getIdentityConflicts(imported, existing);

  return {
    anime: existing,
    confidence: conflicts.length === 0 ? "high" : "review",
    score: conflicts.length === 0 ? 100 : 70,
    reasons: ["Совпадает внутренний ID записи", ...conflicts],
  };
}

function findImportDuplicates(
  imported: AnimeIdentity,
  previousImports: AnimeIdentity[],
): AnimeMatch[] {
  const duplicates: AnimeMatch[] = [];

  for (const previous of previousImports) {
    if (imported.id === previous.id) {
      duplicates.push(createInternalIdMatch(imported, previous));
      continue;
    }

    const matches = findAnimeMatches(imported, [previous]);

    duplicates.push(...matches);
  }

  return duplicates.sort((a, b) => b.score - a.score);
}

export function createImportPreview(
  importedAnime: AnimeIdentity[],
  existingAnime: AnimeIdentity[],
): ImportPreview {
  const items: ImportPreviewItem[] = [];

  for (let index = 0; index < importedAnime.length; index += 1) {
    const imported = importedAnime[index];

    if (!imported) continue;

    const importDuplicates = findImportDuplicates(
      imported,
      importedAnime.slice(0, index),
    );

    if (importDuplicates.length > 0) {
      items.push({
        imported,
        status: "review",
        matches: importDuplicates,
        selectedMatch: null,
        reason:
          "В импортируемом файле найдено возможное дублирование. Импорт этой записи заблокирован до проверки.",
        duplicateInImport: true,
      });

      continue;
    }

    const sameId = existingAnime.find(
      (existing) => existing.id === imported.id,
    );

    if (sameId) {
      const directMatch = createInternalIdMatch(imported, sameId);
      const hasConflicts = directMatch.confidence === "review";

      items.push({
        imported,
        status: hasConflicts ? "review" : "matched",
        matches: [directMatch],
        selectedMatch: hasConflicts ? null : sameId,
        reason: hasConflicts
          ? "Внутренний ID совпадает, но характеристики записей противоречат друг другу"
          : "Запись с таким ID уже существует",
        duplicateInImport: false,
      });

      continue;
    }

    const matches = findAnimeMatches(imported, existingAnime);

    if (matches.length === 0) {
      items.push({
        imported,
        status: "new",
        matches: [],
        selectedMatch: null,
        reason: "Совпадений в существующей библиотеке не найдено",
        duplicateInImport: false,
      });

      continue;
    }

    if (matches.length === 1 && matches[0]?.confidence === "high") {
      const match = matches[0];

      items.push({
        imported,
        status: "matched",
        matches,
        selectedMatch: match.anime,
        reason: "Найдено одно совпадение с высокой уверенностью",
        duplicateInImport: false,
      });

      continue;
    }

    items.push({
      imported,
      status: "review",
      matches,
      selectedMatch: null,
      reason:
        matches.length > 1
          ? "Найдено несколько возможных совпадений"
          : "Совпадение требует ручной проверки",
      duplicateInImport: false,
    });
  }

  return {
    items,
    summary: {
      total: items.length,
      new: items.filter((item) => item.status === "new").length,
      matched: items.filter((item) => item.status === "matched").length,
      review: items.filter((item) => item.status === "review").length,
    },
  };
}
