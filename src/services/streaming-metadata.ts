function normalizeStreamingTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

/**
 * Borrows only a poster from another streaming catalogue.
 * This deliberately does not create or attach a library identity and never
 * changes the AnimeGO title, URL, rating, year, or provider identifiers.
 */
export function applyStreamingPosterFallback(
  item: StreamingTitle,
  candidates: StreamingTitle[],
): StreamingTitle {
  const itemTitles = new Set(
    [item.title, ...(item.alternativeTitles || [])]
      .map(normalizeStreamingTitle)
      .filter((value) => value.length >= 3),
  );
  if (!itemTitles.size) return item;

  let matches = candidates.filter((candidate) => {
    if (candidate.provider === item.provider || !candidate.posterUrl) return false;
    const candidateTitles = [candidate.title, ...(candidate.alternativeTitles || [])]
      .map(normalizeStreamingTitle)
      .filter((value) => value.length >= 3);
    return candidateTitles.some((value) => itemTitles.has(value));
  });

  if (item.year != null) {
    const sameYear = matches.filter((candidate) => candidate.year === item.year);
    if (sameYear.length) matches = sameYear;
    else if (matches.some((candidate) => candidate.year != null)) return item;
  }
  if (matches.length !== 1) return item;

  const match = matches[0]!;
  if (item.year != null && match.year != null && item.year !== match.year) return item;
  const borrowedPoster = match.posterUrl;
  if (!borrowedPoster || borrowedPoster === item.posterUrl) return item;

  return {
    ...item,
    posterUrl: borrowedPoster,
    fallbackPosterUrl: item.posterUrl || item.fallbackPosterUrl || null,
    posterSource: match.provider === "anixart" ? "AnixART" : match.provider,
  };
}
