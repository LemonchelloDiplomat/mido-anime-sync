import type { AnimeAgeRating, AnimeFormat, AnimeIdentity, AnimeListEntry, AnimeReleaseStatus } from "./types.js";

export type GenreMode = "include" | "exclude";
export interface LibraryFilters {
  query: string;
  yearFrom: number;
  yearTo: number;
  genres: Record<string, GenreMode>;
  strictGenres: boolean;
  formats: AnimeFormat[];
  releaseStatuses: AnimeReleaseStatus[];
  ageRatings: AnimeAgeRating[];
  episodeRanges: Array<"SHORT" | "MEDIUM" | "LONG" | "VERY_LONG">;
  recentOnly: boolean;
  status: AnimeListEntry["status"] | "ALL";
}
export interface LibraryItem {
  anime: AnimeIdentity;
  entry: AnimeListEntry | undefined;
}
export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  query: "",
  yearFrom: 1959,
  yearTo: new Date().getFullYear() + 1,
  genres: {},
  strictGenres: false,
  formats: [],
  releaseStatuses: [],
  ageRatings: [],
  episodeRanges: [],
  recentOnly: false,
  status: "ALL",
};

export function matchesLibraryFilters(
  item: LibraryItem,
  filters: LibraryFilters,
  now = new Date(),
): boolean {
  const { anime, entry } = item;
  const query = filters.query.trim().toLocaleLowerCase();
  const title = [
    anime.titles.english, anime.titles.romaji, anime.titles.native,
    ...anime.titles.synonyms,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  if (query && !title.includes(query)) return false;

  if (filters.status !== "ALL" && entry?.status !== filters.status) return false;
  if (anime.year != null && (anime.year < filters.yearFrom || anime.year > filters.yearTo)) return false;
  if (anime.year == null && (filters.yearFrom > 1959 || filters.yearTo < now.getFullYear() + 1)) return false;

  if (filters.formats.length && (!anime.format || !filters.formats.includes(anime.format))) return false;
  if (filters.releaseStatuses.length && (!anime.releaseStatus || !filters.releaseStatuses.includes(anime.releaseStatus))) return false;
  if (filters.ageRatings.length && (!anime.ageRating || !filters.ageRatings.includes(anime.ageRating))) return false;

  if (filters.recentOnly) {
    if (!anime.startDate) return false;
    const start = Date.parse(`${anime.startDate}T00:00:00`);
    const age = now.getTime() - start;
    if (!Number.isFinite(start) || age < 0 || age > 183 * 24 * 60 * 60 * 1000) return false;
  }

  if (filters.episodeRanges.length) {
    const count = anime.episodes;
    if (count == null) return false;
    const inRange =
      (filters.episodeRanges.includes("SHORT") && count <= 13) ||
      (filters.episodeRanges.includes("MEDIUM") && count >= 14 && count <= 26) ||
      (filters.episodeRanges.includes("LONG") && count >= 27 && count <= 100) ||
      (filters.episodeRanges.includes("VERY_LONG") && count > 100);
    if (!inRange) return false;
  }

  const selectedGenres = Object.entries(filters.genres);
  const included = selectedGenres.filter(([, mode]) => mode === "include").map(([genre]) => genre);
  const excluded = selectedGenres.filter(([, mode]) => mode === "exclude").map(([genre]) => genre);
  const animeGenres = new Set(anime.genres ?? []);
  if (excluded.some((genre) => animeGenres.has(genre))) return false;
  if (included.length) {
    const matches = included.filter((genre) => animeGenres.has(genre)).length;
    if (filters.strictGenres ? matches !== included.length : matches === 0) return false;
  }
  return true;
}

export function filterLibrary<T extends LibraryItem>(
  items: T[],
  filters: LibraryFilters,
  now = new Date(),
): T[] {
  return items.filter((item) => matchesLibraryFilters(item, filters, now));
}
