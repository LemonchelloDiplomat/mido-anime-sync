import type {
  AnimeFormat,
  AnimeIdentity,
  AnimeReleaseStatus,
} from "../core/types.js";
import type { CatalogMetadataProvider } from "./catalog-provider.js";

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

const GENRE_TRANSLATIONS: Record<string, string> = {
  Action: "Экшен",
  Adventure: "Приключения",
  Comedy: "Комедия",
  Drama: "Драма",
  Ecchi: "Этти",
  Fantasy: "Фэнтези",
  Hentai: "Хентай",
  Horror: "Ужасы",
  Mecha: "Меха",
  Music: "Музыка",
  Mystery: "Тайна",
  Psychological: "Психологическое",
  Romance: "Романтика",
  "Sci-Fi": "Фантастика",
  "Slice of Life": "Повседневность",
  Sports: "Спорт",
  Supernatural: "Сверхъестественное",
  Thriller: "Триллер",
};

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
    genres: [...new Set((media.genres ?? []).map((genre) => GENRE_TRANSLATIONS[genre] ?? genre))],
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


/**
 * Searches several streaming-catalogue titles in one GraphQL operation.
 * This avoids firing many parallel AniList requests and hitting its rate limit.
 */
export async function searchAniListAnimeBatch(
  rawQueries: string[],
  signal?: AbortSignal,
): Promise<AnimeIdentity[]> {
  const searches = [...new Set(rawQueries.map((value) => value.trim()).filter((value) => value.length >= 2))]
    .slice(0, 9);
  if (!searches.length) return [];

  const variableDefinitions = searches.map((_, index) => `$search${index}: String!`).join(", ");
  const fields = searches.map((_, index) => `
    results${index}: Page(page: 1, perPage: 20) {
      media(search: $search${index}, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
        id
        idMal
        title { romaji english native }
        synonyms
        format
        status
        episodes
        seasonYear
        startDate { year month day }
        averageScore
        genres
        coverImage { extraLarge large }
      }
    }`).join("\n");
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: `query StreamingCatalogueFallback(${variableDefinitions}) { ${fields} }`,
      variables: Object.fromEntries(searches.map((value, index) => [`search${index}`, value.slice(0, 100)])),
    }),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 429) {
    throw new Error("AniList временно ограничил частоту запросов. Повтори поиск немного позже.");
  }
  if (!response.ok) throw new Error(`AniList вернул ошибку HTTP ${response.status} при поиске метаданных.`);

  const payload = await response.json() as {
    data?: Record<string, { media?: AniListMedia[] }>;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "AniList не смог выполнить пакетный поиск.");
  }
  if (!payload.data) throw new Error("AniList вернул ответ в неожиданном формате.");

  const unique = new Map<string, AnimeIdentity>();
  searches.forEach((_, index) => {
    const media = payload.data?.[`results${index}`]?.media;
    if (!Array.isArray(media)) return;
    for (const entry of media) {
      const identity = mapMedia(entry);
      unique.set(identity.externalIds.anilist || identity.id, identity);
    }
  });
  return [...unique.values()];
}


const MAL_METADATA_BATCH_SIZE = 20;
const ANILIST_METADATA_MIN_INTERVAL_MS = 2_200;
let lastAniListMetadataRequestAt = 0;

/** Returns only MAL entries that have not already been resolved to AniList. */
export function getAniListMetadataCandidates(
  identities: AnimeIdentity[],
): AnimeIdentity[] {
  return identities.filter((anime) => {
    const malId = anime.externalIds.myanimelist;
    return Boolean(
      malId &&
      /^\d+$/.test(malId) &&
      Number.isSafeInteger(Number(malId)) &&
      Number(malId) > 0 &&
      !anime.externalIds.anilist,
    );
  });
}

const MAL_METADATA_FRAGMENT = `
  fragment AnimeMetadata on Media {
    id
    idMal
    title { romaji english native }
    synonyms
    format
    status
    episodes
    seasonYear
    startDate { year month day }
    averageScore
    genres
    coverImage { extraLarge large }
  }
`;

interface AniListMetadataResponse {
  data?: Record<string, AniListMedia | null>;
  errors?: Array<{ message?: string }>;
}

interface AniListMetadataMatch {
  malId: string;
  anime: AnimeIdentity;
}

function createMalMetadataQuery(malIds: string[]) {
  const variableDefinitions = malIds
    .map((_, index) => `$malId${index}: Int!`)
    .join(", ");
  const fields = malIds
    .map((_, index) =>
      `anime${index}: Media(idMal: $malId${index}, type: ANIME) { ...AnimeMetadata }`,
    )
    .join("\n");

  return {
    query: `query EnrichAnimeByMalIds(${variableDefinitions}) {
      ${fields}
    }
    ${MAL_METADATA_FRAGMENT}`,
    variables: Object.fromEntries(
      malIds.map((malId, index) => [`malId${index}`, Number(malId)]),
    ),
  };
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

class AniListMetadataHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AniListMetadataHttpError";
  }
}

async function fetchAniListMetadataQuery(
  malIds: string[],
  signal?: AbortSignal,
): Promise<AniListMetadataResponse> {
  const request = createMalMetadataQuery(malIds);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const waitMs = Math.max(
      0,
      ANILIST_METADATA_MIN_INTERVAL_MS - (Date.now() - lastAniListMetadataRequestAt),
    );
    if (waitMs > 0) await waitForRetry(waitMs, signal);
    lastAniListMetadataRequestAt = Date.now();

    const response = await fetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const resetAt = Number(response.headers.get("X-RateLimit-Reset"));
      const resetDelay = Number.isFinite(resetAt) && resetAt > 0
        ? resetAt * 1000 - Date.now() + 1_000
        : 61_000;
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 + 1_000
        : Math.max(1_000, resetDelay);
      await waitForRetry(Math.min(delay, 120_000), signal);
      continue;
    }

    if (response.status === 429) {
      throw new Error("AniList временно ограничил частоту запросов. Повтори обогащение немного позже.");
    }
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 500).trim();
      const detail = responseBody
        ? ` Ответ сервера: ${responseBody.replace(/\s+/g, " ")}`
        : "";
      throw new AniListMetadataHttpError(
        response.status,
        `AniList вернул HTTP ${response.status} для пакета MAL ID ${malIds[0]}–${malIds[malIds.length - 1]}.${detail}`,
      );
    }

    const payload = (await response.json()) as AniListMetadataResponse;
    if (payload.errors?.length && !payload.data) {
      throw new Error(payload.errors[0]?.message ?? "AniList не смог обогатить библиотеку.");
    }
    if (!payload.data) {
      throw new Error("AniList вернул ответ в неожиданном формате.");
    }

    return payload;
  }

  throw new Error("Не удалось получить данные из AniList.");
}

/**
 * A single unknown MAL ID can make AniList return HTTP 404 for the whole
 * aliased GraphQL operation. Split only those failed batches until the
 * missing ID is isolated, so valid IDs in the same batch are still enriched.
 */
async function fetchAniListMetadataBatch(
  malIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, AniListMedia | null>> {
  try {
    const payload = await fetchAniListMetadataQuery(malIds, signal);
    return new Map(
      malIds.map((malId, index) => [
        malId,
        payload.data?.[`anime${index}`] ?? null,
      ]),
    );
  } catch (error) {
    if (!(error instanceof AniListMetadataHttpError) || error.status !== 404) {
      throw error;
    }

    if (malIds.length === 1) {
      return new Map([[malIds[0]!, null]]);
    }

    const midpoint = Math.floor(malIds.length / 2);
    const firstHalf = await fetchAniListMetadataBatch(malIds.slice(0, midpoint), signal);
    const secondHalf = await fetchAniListMetadataBatch(malIds.slice(midpoint), signal);
    return new Map([...firstHalf, ...secondHalf]);
  }
}

/**
 * AniList provider. It resolves MAL records by exact MAL ID, never by title.
 * Several IDs are queried in one GraphQL request to avoid one request per anime.
 */
export const aniListMetadataProvider: CatalogMetadataProvider = {
  id: "anilist",
  name: "AniList",

  async enrich(identities, options = {}) {
    const candidates = getAniListMetadataCandidates(identities);
    const pendingByMalId = new Map<string, AnimeIdentity[]>();
    for (const anime of candidates) {
      const malId = anime.externalIds.myanimelist;
      if (!malId) continue;
      const group = pendingByMalId.get(malId) ?? [];
      group.push(anime);
      pendingByMalId.set(malId, group);
    }

    const malIds = [...pendingByMalId.keys()];
    for (let offset = 0; offset < malIds.length; offset += MAL_METADATA_BATCH_SIZE) {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const batchIds = malIds.slice(offset, offset + MAL_METADATA_BATCH_SIZE);
      const metadataByMalId = await fetchAniListMetadataBatch(batchIds, options.signal);
      const matches: Array<{ animeId: string; metadata: AnimeIdentity }> = [];
      const missingIds: string[] = [];

      batchIds.forEach((malId) => {
        const media = metadataByMalId.get(malId);
        if (!media || String(media.idMal ?? "") !== malId) {
          missingIds.push(malId);
          return;
        }

        const metadata = mapMedia(media);
        for (const localAnime of pendingByMalId.get(malId) ?? []) {
          matches.push({ animeId: localAnime.id, metadata });
        }
      });

      await options.onBatch?.({
        completed: offset + batchIds.length,
        total: malIds.length,
        matched: batchIds.length - missingIds.length,
        missing: missingIds.length,
        matches,
      });
    }
  },
};


export interface AniListAnimeDetails {
  anime: AnimeIdentity;
  description: string;
  bannerImage: string | null;
  season: string | null;
  seasonYear: number | null;
  source: string | null;
  duration: number | null;
  studios: string[];
  relations: Array<{
    relationType: string;
    anime: AnimeIdentity;
  }>;
}

const DETAILS_QUERY = `
  query AnimeDetails($id: Int!) {
    Media(id: $id, type: ANIME) {
      id
      idMal
      title { romaji english native }
      synonyms
      format
      status
      episodes
      seasonYear
      startDate { year month day }
      averageScore
      genres
      description(asHtml: false)
      bannerImage
      season
      source
      duration
      coverImage { extraLarge large }
      studios(isMain: true) {
        nodes { name }
      }
      relations {
        edges {
          relationType
          node {
            id
            idMal
            type
            title { romaji english native }
            synonyms
            format
            status
            episodes
            seasonYear
            startDate { year month day }
            averageScore
            genres
            coverImage { extraLarge large }
          }
        }
      }
    }
  }
`;

interface AniListDetailsResponse {
  data?: {
    Media?: AniListMedia & {
      description: string | null;
      bannerImage: string | null;
      season: string | null;
      source: string | null;
      duration: number | null;
      studios: { nodes: Array<{ name: string }> };
      relations: {
        edges: Array<{
          relationType: string;
          node: AniListMedia & { type: string };
        }>;
      };
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export async function fetchAniListAnimeDetails(
  id: number,
  signal?: AbortSignal,
): Promise<AniListAnimeDetails> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Некорректный ID аниме в AniList.");
  }

  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: DETAILS_QUERY,
      variables: { id },
    }),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 429) {
    throw new Error("AniList временно ограничил частоту запросов. Попробуй через минуту.");
  }
  if (!response.ok) {
    throw new Error(`AniList вернул ошибку HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as AniListDetailsResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "Не удалось загрузить страницу аниме.");
  }

  const media = payload.data?.Media;
  if (!media) {
    throw new Error("AniList не нашёл это аниме.");
  }

  const anime = mapMedia(media);
  return {
    anime,
    description: (media.description ?? "").replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim(),
    bannerImage: media.bannerImage,
    season: media.season,
    seasonYear: media.seasonYear,
    source: media.source,
    duration: media.duration,
    studios: (media.studios?.nodes ?? []).map((studio) => studio.name).filter(Boolean),
    relations: (media.relations?.edges ?? [])
      .filter((edge) => edge.node.type === "ANIME")
      .map((edge) => ({
        relationType: edge.relationType,
        anime: mapMedia(edge.node),
      })),
  };
}
