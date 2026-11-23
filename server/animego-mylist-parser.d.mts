export interface AnimeGoMyListItem {
  provider: "animego";
  listEntryId: string;
  animeId: string | null;
  animeSlug: string;
  url: string;
  title: string;
  alternativeTitle: string | null;
  posterUrl: string | null;
  listType: number;
  releaseStatus: string | null;
  episodesWatched: number | null;
  episodesTotal: number | null;
  progressText: string | null;
}

export interface AnimeGoMyListParseResult {
  items: AnimeGoMyListItem[];
  nextPageFrameId: string | null;
  nextPageUrl: string | null;
}

export interface AnimeGoMyListParseOptions {
  baseUrl?: string;
  listType?: number;
}

export function parseAnimeGoMyListResponse(
  html: string,
  options?: AnimeGoMyListParseOptions,
): AnimeGoMyListParseResult;
