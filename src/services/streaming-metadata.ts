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
  options: { preferPoster?: boolean } = {},
): StreamingTitle {
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
  const matchedPoster = match.posterUrl || null;
  return {
    ...item,
    fallbackPosterUrl: matchedPoster && matchedPoster !== (options.preferPoster ? (match.posterUrl || item.posterUrl) : item.posterUrl) ? matchedPoster : item.fallbackPosterUrl || null,
    // AnimeGO's CDN URLs are frequently unavailable to embedded clients.
    // Prefer a verified AniList cover for this provider, but only after an exact title match.
    posterUrl: options.preferPoster ? (match.posterUrl || item.posterUrl || null) : (item.posterUrl || match.posterUrl || null),
    averageScore: item.averageScore ?? match.averageScore ?? null,
    year: item.year ?? match.year ?? null,
    posterSource: options.preferPoster && match.posterUrl ? "AniList" : item.posterUrl ? (item.posterSource || item.provider) : match.posterUrl ? "AniList" : null,
    scoreSource: item.averageScore != null ? (item.scoreSource || item.provider) : match.averageScore != null ? "AniList" : null,
    identity: item.identity || match,
  };
}
