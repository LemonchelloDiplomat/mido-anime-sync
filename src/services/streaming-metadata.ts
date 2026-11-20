import type { AnimeIdentity } from "../core/types.js";
import type { StreamingTitle } from "./streaming-provider.js";

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function identityTitles(identity: AnimeIdentity): string[] {
  return [
    identity.titles.english,
    identity.titles.romaji,
    identity.titles.native,
    ...(identity.titles.synonyms || []),
  ].filter((value): value is string => Boolean(value)).map(normalizeTitle).filter(Boolean);
}

/**
 * Only borrows metadata after an exact normalized title/alias match.
 * If multiple catalogue entries share that title, year must disambiguate them.
 */
export function applyFallbackMetadata(
  item: StreamingTitle,
  candidates: AnimeIdentity[],
): StreamingTitle {
  if (item.posterUrl && item.averageScore != null) return item;
  const itemTitles = [item.title, ...(item.alternativeTitles || [])].map(normalizeTitle).filter(Boolean);
  if (!itemTitles.length) return item;
  let matches = candidates.filter((candidate) =>
    identityTitles(candidate).some((candidateTitle) => itemTitles.includes(candidateTitle)),
  );
  if (item.year != null) {
    const sameYear = matches.filter((candidate) => candidate.year === item.year);
    if (sameYear.length) matches = sameYear;
  }
  if (matches.length !== 1) return item;
  const match = matches[0]!;
  return {
    ...item,
    posterUrl: item.posterUrl || match.posterUrl || null,
    averageScore: item.averageScore ?? match.averageScore ?? null,
    posterSource: item.posterUrl ? (item.posterSource || item.provider) : match.posterUrl ? "AniList" : null,
    scoreSource: item.averageScore != null ? (item.scoreSource || item.provider) : match.averageScore != null ? "AniList" : null,
    identity: item.identity || match,
  };
}
