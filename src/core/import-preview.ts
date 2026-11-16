import type { AnimeIdentity } from "./types.js";

export type ImportPreviewStatus = "new" | "matched";

export interface ImportPreviewItem {
  imported: AnimeIdentity;
  status: ImportPreviewStatus;
  matchedAnime: AnimeIdentity | null;
  reason: string;
}

export interface ImportPreview {
  items: ImportPreviewItem[];
  summary: {
    total: number;
    new: number;
    matched: number;
  };
}

function getExternalIdConflicts(
  imported: AnimeIdentity,
  existing: AnimeIdentity,
): string[] {
  return Object.entries(imported.externalIds)
    .filter(([service, externalId]) => {
      if (!externalId) return false;
      const existingId =
        existing.externalIds[service as keyof AnimeIdentity["externalIds"]];
      return Boolean(existingId && existingId !== externalId);
    })
    .map(([service]) => service);
}

function getSharedExternalId(
  imported: AnimeIdentity,
  existing: AnimeIdentity,
): string | null {
  for (const [service, externalId] of Object.entries(imported.externalIds)) {
    if (!externalId) continue;

    const existingId =
      existing.externalIds[service as keyof AnimeIdentity["externalIds"]];

    if (existingId === externalId) return service;
  }

  return null;
}

/**
 * Сопоставляет импорт только по точным идентификаторам.
 * Похожие названия, сезоны, фильмы и спешлы не считаются дублями.
 * Неоднозначное совпадение точных ID считается ошибкой целостности данных,
 * а не поводом блокировать импорт с ручным разбором сотен карточек.
 */
export function createImportPreview(
  importedAnime: AnimeIdentity[],
  existingAnime: AnimeIdentity[],
): ImportPreview {
  const importedIds = new Set<string>();
  const externalIds = new Set<string>();
  const items: ImportPreviewItem[] = [];

  for (const imported of importedAnime) {
    if (importedIds.has(imported.id)) {
      throw new Error(`В импортируемом файле повторяется внутренний ID: ${imported.id}.`);
    }
    importedIds.add(imported.id);

    for (const [service, externalId] of Object.entries(imported.externalIds)) {
      if (!externalId) continue;
      const key = `${service}:${externalId}`;

      if (externalIds.has(key)) {
        throw new Error(`В импортируемом файле повторяется внешний ID ${key}. Проверь исходный файл.`);
      }

      externalIds.add(key);
    }

    const exactMatches = existingAnime.filter((existing) =>
      existing.id === imported.id || getSharedExternalId(imported, existing) !== null,
    );

    if (exactMatches.length > 1) {
      throw new Error(
        `В библиотеке найдено несколько записей с одним и тем же внешним ID для аниме ${imported.titles.english ?? imported.titles.romaji ?? imported.id}. Сначала исправь дубли в библиотеке.`,
      );
    }

    const matchedAnime = exactMatches[0] ?? null;

    if (matchedAnime) {
      const conflicts = getExternalIdConflicts(imported, matchedAnime);
      if (conflicts.length > 0) {
        throw new Error(
          `Нельзя объединить записи ${imported.id} и ${matchedAnime.id}: различаются внешние ID сервисов ${conflicts.join(", ")}.`,
        );
      }
    }

    items.push({
      imported,
      status: matchedAnime ? "matched" : "new",
      matchedAnime,
      reason: matchedAnime
        ? "Совпадает точный внутренний или внешний ID"
        : "Тайтл будет добавлен как новая запись",
    });
  }

  return {
    items,
    summary: {
      total: items.length,
      new: items.filter((item) => item.status === "new").length,
      matched: items.filter((item) => item.status === "matched").length,
    },
  };
}
