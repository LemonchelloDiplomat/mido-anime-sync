import type { AnimeIdentity, ServiceId } from "./types.js";

export type MatchConfidence = "high" | "review";

export interface AnimeMatch {
  anime: AnimeIdentity;
  confidence: MatchConfidence;
  score: number;
  reasons: string[];
}

interface ExternalIdEvidence {
  matchedServices: ServiceId[];
  conflictingServices: ServiceId[];
}

/**
 * Нормализует название для сравнения.
 * Сохраняет значимые числа, включая номера сезонов.
 */
export function normalizeAnimeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getTitles(anime: AnimeIdentity): Set<string> {
  const values = [
    anime.titles.english,
    anime.titles.romaji,
    anime.titles.native,
    ...anime.titles.synonyms,
  ];

  return new Set(
    values
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeAnimeTitle)
      .filter(Boolean),
  );
}

function getSharedTitles(
  first: AnimeIdentity,
  second: AnimeIdentity,
): string[] {
  const firstTitles = getTitles(first);
  const secondTitles = getTitles(second);

  return [...firstTitles].filter((title) => secondTitles.has(title));
}

/**
 * Сравнивает внешние ID только внутри одного сервиса.
 * Пробелы по краям ID игнорируются.
 */
function getExternalIdEvidence(
  first: AnimeIdentity,
  second: AnimeIdentity,
): ExternalIdEvidence {
  const services = new Set([
    ...Object.keys(first.externalIds),
    ...Object.keys(second.externalIds),
  ]) as Set<ServiceId>;

  const matchedServices: ServiceId[] = [];
  const conflictingServices: ServiceId[] = [];

  for (const service of services) {
    const firstId = first.externalIds[service]?.trim();
    const secondId = second.externalIds[service]?.trim();

    if (!firstId || !secondId) {
      continue;
    }

    if (firstId === secondId) {
      matchedServices.push(service);
    } else {
      conflictingServices.push(service);
    }
  }

  return {
    matchedServices,
    conflictingServices,
  };
}

function hasKnownFormat(anime: AnimeIdentity): boolean {
  return anime.format !== undefined && anime.format !== "UNKNOWN";
}

/**
 * Проверяет противоречия между характеристиками двух аниме.
 */
function getIdentityConflicts(
  first: AnimeIdentity,
  second: AnimeIdentity,
): string[] {
  const conflicts: string[] = [];

  const firstTitles = getTitles(first);
  const secondTitles = getTitles(second);

  if (
    firstTitles.size > 0 &&
    secondTitles.size > 0 &&
    ![...firstTitles].some((title) => secondTitles.has(title))
  ) {
    conflicts.push("Названия различаются");
  }

  if (first.year != null && second.year != null && first.year !== second.year) {
    conflicts.push("Годы выхода различаются");
  }

  if (
    hasKnownFormat(first) &&
    hasKnownFormat(second) &&
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

function compareAnime(
  source: AnimeIdentity,
  candidate: AnimeIdentity,
): AnimeMatch | null {
  if (source.id === candidate.id) {
    return null;
  }

  const externalIds = getExternalIdEvidence(source, candidate);
  const identityConflicts = getIdentityConflicts(source, candidate);

  const externalIdConflict = externalIds.conflictingServices.length > 0;

  // Совпавший внешний ID является сильным доказательством,
  // но противоречия в других данных не должны игнорироваться.
  if (externalIds.matchedServices.length > 0) {
    const reasons = [
      `Совпадает внешний ID: ${externalIds.matchedServices.join(", ")}`,
      ...identityConflicts,
    ];

    if (externalIdConflict) {
      reasons.push(
        `Внешние ID различаются: ${externalIds.conflictingServices.join(", ")}`,
      );
    }

    const hasConflicts = identityConflicts.length > 0 || externalIdConflict;

    return {
      anime: candidate,
      confidence: hasConflicts ? "review" : "high",
      score: externalIdConflict ? 60 : hasConflicts ? 70 : 100,
      reasons,
    };
  }

  const sharedTitles = getSharedTitles(source, candidate);

  if (sharedTitles.length === 0) {
    return null;
  }

  let score = 65;
  const reasons = ["Совпадает название"];

  const yearConflict =
    source.year != null &&
    candidate.year != null &&
    source.year !== candidate.year;

  if (source.year != null && candidate.year != null) {
    if (yearConflict) {
      score -= 30;
      reasons.push("Годы выхода различаются");
    } else {
      score += 15;
      reasons.push("Совпадает год выхода");
    }
  }

  const formatsComparable = hasKnownFormat(source) && hasKnownFormat(candidate);

  const formatConflict =
    formatsComparable && source.format !== candidate.format;

  if (formatsComparable) {
    if (formatConflict) {
      score -= 30;
      reasons.push("Форматы различаются");
    } else {
      score += 10;
      reasons.push("Совпадает формат");
    }
  }

  const episodesConflict =
    source.episodes != null &&
    candidate.episodes != null &&
    source.episodes !== candidate.episodes;

  if (source.episodes != null && candidate.episodes != null) {
    if (episodesConflict) {
      score -= 15;
      reasons.push("Количество эпизодов различается");
    } else {
      score += 5;
      reasons.push("Совпадает количество эпизодов");
    }
  }

  if (externalIdConflict) {
    score -= 25;
    reasons.push(
      `Внешние ID различаются: ${externalIds.conflictingServices.join(", ")}`,
    );
  }

  score = Math.max(0, Math.min(99, score));

  const hasConflicts =
    yearConflict || formatConflict || episodesConflict || externalIdConflict;

  const confidence: MatchConfidence =
    !hasConflicts && score >= 90 ? "high" : "review";

  return {
    anime: candidate,
    confidence,
    score,
    reasons,
  };
}

/**
 * Ищет возможные совпадения.
 * Ничего не записывает и не изменяет в базе.
 */
export function findAnimeMatches(
  source: AnimeIdentity,
  candidates: AnimeIdentity[],
): AnimeMatch[] {
  return candidates
    .map((candidate) => compareAnime(source, candidate))
    .filter((match): match is AnimeMatch => match !== null)
    .sort((a, b) => b.score - a.score);
}
