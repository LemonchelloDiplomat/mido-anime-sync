import type {
  AnimeFormat,
  AnimeIdentity,
  AnimeReleaseStatus,
} from "../core/types.js";

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const SEARCH_QUERY = `
  query SearchAnime($search: String!, $page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        synonyms
        format
        status
        episodes
        seasonYear
        startDate {
          year
          month
          day
        }
        averageScore
        genres
        coverImage {
          extraLarge
          large
        }
      }
    }
  }
`;

interface AniListMedia {
  id: number;
  idMal: number | null;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
  };
  synonyms: string[];
  format: string | null;
  status: string | null;
  episodes: number | null;
  seasonYear: number | null;
  startDate: {
    year: number | null;
    month: number | null;
    day: number | null;
  };
  averageScore: number | null;
  genres: string[];
  coverImage: {
    extraLarge: string | null;
    large: string | null;
  };
}

interface AniListSearchResponse {
  data?: {
    Page?: {
      media?: AniListMedia[];
    };
  };
  errors?: Array<{ message?: string }>;
}

function mapFormat(value: string | null): AnimeFormat | undefined {
  switch (value) {
    case "TV":
    case "TV_SHORT":
      return "TV";
    case "MOVIE":
      return "MOVIE";
    case "SPECIAL":
      return "SPECIAL";
    case "OVA":
      return "OVA";
    case "ONA":
      return "ONA";
    case "MUSIC":
      return "MUSIC";
    default:
      return undefined;
  }
}

function mapReleaseStatus(value: string | null): AnimeReleaseStatus | undefined {
  switch (value) {
    case "RELEASING":
      return "ONGOING";
    case "NOT_YET_RELEASED":
      return "ANNOUNCED";
    case "FINISHED":
      return "RELEASED";
    default:
      return undefined;
  }
}

function mapStartDate(value: AniListMedia["startDate"]): string | null {
  if (value.year == null || value.month == null || value.day == null) {
    return null;
  }

  const month = String(value.month).padStart(2, "0");
  const day = String(value.day).padStart(2, "0");
  return `${value.year}-${month}-${day}`;
}

function mapMedia(media: AniListMedia): AnimeIdentity {
  const startDate = mapStartDate(media.startDate);
  const synonyms = [...new Set(
    (media.synonyms ?? [])
      .map((title) => title.trim())
      .filter(Boolean),
  )];

  return {
    id: `anilist:${media.id}`,
    titles: {
      ...(media.title.romaji ? { romaji: media.title.romaji } : {}),
      ...(media.title.english ? { english: media.title.english } : {}),
      ...(media.title.native ? { native: media.title.native } : {}),
      synonyms,
    },
    externalIds: {
      anilist: String(media.id),
      ...(media.idMal != null ? { myanimelist: String(media.idMal) } : {}),
    },
    year: startDate
      ? media.startDate.year
      : media.startDate.year ?? media.seasonYear,
    ...(mapFormat(media.format) ? { format: mapFormat(media.format)! } : {}),
    episodes: media.episodes,
    genres: [...new Set(media.genres ?? [])],
    posterUrl: media.coverImage.extraLarge ?? media.coverImage.large,
    averageScore:
      media.averageScore == null ? null : media.averageScore / 10,
    startDate,
    ...(mapReleaseStatus(media.status)
      ? { releaseStatus: mapReleaseStatus(media.status)! }
      : {}),
  };
}

export async function searchAniListAnime(
  rawQuery: string,
  signal?: AbortSignal,
): Promise<AnimeIdentity[]> {
  const search = rawQuery.trim();
  if (search.length < 2) return [];

  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        search: search.slice(0, 100),
        page: 1,
        perPage: 20,
      },
    }),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 429) {
    throw new Error("AniList временно ограничил частоту запросов. Попробуй через минуту.");
  }

  if (!response.ok) {
    throw new Error(`AniList вернул ошибку HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as AniListSearchResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "AniList не смог выполнить поиск.");
  }

  const media = payload.data?.Page?.media;
  if (!Array.isArray(media)) {
    throw new Error("AniList вернул ответ в неожиданном формате.");
  }

  return media.map(mapMedia);
}
