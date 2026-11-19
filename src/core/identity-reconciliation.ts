import type { AnimeIdentity } from "./types.js";

export interface ExactIdentityDuplicatePair {
  first: AnimeIdentity;
  second: AnimeIdentity;
  sharedServices: string[];
}

/**
 * Finds pairs that share an exact external identifier from the same service.
 * Similar titles are deliberately ignored: seasons, movies and specials may
 * have similar names while representing different works.
 */
export function findExactIdentityDuplicatePairs(
  anime: AnimeIdentity[],
): ExactIdentityDuplicatePair[] {
  const pairs: ExactIdentityDuplicatePair[] = [];

  for (let firstIndex = 0; firstIndex < anime.length; firstIndex += 1) {
    const first = anime[firstIndex];
    if (!first) continue;

    for (let secondIndex = firstIndex + 1; secondIndex < anime.length; secondIndex += 1) {
      const second = anime[secondIndex];
      if (!second || first.id === second.id) continue;

      const sharedServices = Object.entries(first.externalIds)
        .filter(([service, externalId]) => {
          if (!externalId?.trim()) return false;
          const otherId = second.externalIds[service as keyof AnimeIdentity["externalIds"]];
          return Boolean(otherId?.trim() && otherId.trim() === externalId.trim());
        })
        .map(([service]) => service);

      if (sharedServices.length > 0) {
        pairs.push({ first, second, sharedServices });
      }
    }
  }

  return pairs;
}
