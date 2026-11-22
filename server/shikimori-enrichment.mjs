const DEFAULT_BATCH_SIZE = 50;

export const SHIKIMORI_USER_ANIME_RATES_QUERY = `
  query ShikimoriUserAnimeRates($page: PositiveInt!, $limit: PositiveInt!) {
    userRates(page: $page, limit: $limit, targetType: Anime) {
      id
      status
      score
      episodes
      rewatches
      text
      updatedAt
      anime {
        id
        malId
        name
        russian
        kind
        episodes
        score
        airedOn { date year month day }
        poster { originalUrl mainUrl }
      }
    }
  }
`;

export async function fetchShikimoriAnimeRates(
  requestGraphql,
  { pageSize = DEFAULT_BATCH_SIZE, maxPages = 100 } = {},
) {
  if (typeof requestGraphql !== "function") {
    throw new Error("Не настроен GraphQL-запрос Shikimori.");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_BATCH_SIZE) {
    throw new Error("Размер страницы Shikimori должен быть от 1 до 50.");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error("Некорректный лимит страниц Shikimori.");
  }

  const rates = [];
  const seenRateIds = new Set();
  const seenAnimeIds = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await requestGraphql(SHIKIMORI_USER_ANIME_RATES_QUERY, {
      page,
      limit: pageSize,
    });
    if (!data || !Array.isArray(data.userRates)) {
      throw new Error("Shikimori GraphQL не вернул userRates в ожидаемом формате.");
    }

    const batch = data.userRates;
    for (const rate of batch) {
      const rateId = normalizeAnimeId(rate?.id);
      const animeId = normalizeAnimeId(rate?.anime?.id);
      if (!rateId || !animeId || typeof rate?.anime?.name !== "string" || !rate.anime.name.trim()) {
        throw new Error("Shikimori GraphQL вернул некорректную запись userRates.");
      }
      if (seenRateIds.has(rateId) || seenAnimeIds.has(animeId)) {
        throw new Error("Shikimori GraphQL вернул повторяющуюся запись или аниме в userRates.");
      }
      seenRateIds.add(rateId);
      seenAnimeIds.add(animeId);
      rates.push({
        id: rateId,
        status: rate.status,
        score: rate.score,
        episodes: rate.episodes,
        rewatches: rate.rewatches,
        text: rate.text,
        updated_at: rate.updatedAt,
        anime: {
          id: animeId,
          malId: rate.anime.malId ?? null,
          name: rate.anime.name,
          russian: rate.anime.russian ?? null,
          kind: rate.anime.kind ?? null,
          episodes: rate.anime.episodes ?? null,
          score: rate.anime.score ?? null,
          aired_on: rate.anime.airedOn?.date ?? null,
          image: {
            original: rate.anime.poster?.originalUrl ?? null,
            preview: rate.anime.poster?.mainUrl ?? null,
          },
        },
      });
    }

    if (batch.length < pageSize) return rates;
  }

  throw new Error("Список Shikimori превысил безопасный лимит страниц.");
}

export const SHIKIMORI_ANIME_IDENTITY_QUERY = `
  query ShikimoriAnimeIdentity($ids: String) {
    animes(ids: $ids) {
      id
      malId
    }
  }
`;

/**
 * Loads the canonical Shikimori-to-MAL identity mapping from GraphQL.
 * Shikimori's malId is a separate nullable field; its native id is never
 * treated as a MAL ID.
 */
export async function fetchShikimoriAnimeIdentityBatch(ids, requestGraphql) {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Переданы некорректные Shikimori ID для GraphQL.");
  }
  if (typeof requestGraphql !== "function") {
    throw new Error("Не настроен GraphQL-запрос Shikimori.");
  }
  if (ids.length === 0) return [];

  const data = await requestGraphql(SHIKIMORI_ANIME_IDENTITY_QUERY, {
    ids: ids.join(","),
  });
  if (!data || !Array.isArray(data.animes)) {
    throw new Error("Shikimori GraphQL вернул список аниме в неожиданном формате.");
  }

  return data.animes.map((anime) => ({
    id: anime?.id,
    malId: anime?.malId ?? null,
  }));
}

function normalizeAnimeId(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readMyAnimeListId(anime) {
  return normalizeAnimeId(
    anime?.myanimelist_id ?? anime?.mal_id ?? anime?.malId,
  );
}

/**
 * Summarizes how much of a Shikimori account can be linked to MAL IDs.
 * This is diagnostic metadata only; it never guesses an identity.
 */
export function getShikimoriIdentityCoverage(rates) {
  if (!Array.isArray(rates)) {
    throw new Error("Shikimori вернул список в неожиданном формате.");
  }
  const total = rates.length;
  const withMyAnimeListId = rates.filter((rate) => readMyAnimeListId(rate?.anime) !== null).length;
  const missingAnimeIds = rates
    .filter((rate) => readMyAnimeListId(rate?.anime) === null)
    .map((rate) => normalizeAnimeId(rate?.anime?.id))
    .filter((id) => id !== null)
    .slice(0, 10);

  return {
    total,
    withMyAnimeListId,
    withoutMyAnimeListId: total - withMyAnimeListId,
    sampleMissingAnimeIds: missingAnimeIds,
  };
}

/** Legacy REST enrichment helper retained for compatibility and regression tests. */
export async function enrichShikimoriAnimeRates(
  rates,
  fetchAnimeBatch,
  fetchAnimeById,
  batchSize = DEFAULT_BATCH_SIZE,
  { resolveMissingIndividually = true } = {},
) {
  if (!Array.isArray(rates)) throw new Error("Shikimori вернул список в неожиданном формате.");
  if (typeof fetchAnimeBatch !== "function" || typeof fetchAnimeById !== "function") {
    throw new Error("Не настроено получение подробных данных Shikimori.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) {
    throw new Error("Размер пакета Shikimori должен быть от 1 до 50.");
  }

  const ids = [];
  const seenIds = new Set();
  for (const rate of rates) {
    const id = normalizeAnimeId(rate?.anime?.id);
    if (!id) throw new Error("Shikimori вернул запись без корректного ID аниме.");
    if (readMyAnimeListId(rate.anime) === null && !seenIds.has(id)) {
      seenIds.add(id);
      ids.push(id);
    }
  }

  const detailsById = new Map();
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batchIds = ids.slice(offset, offset + batchSize);
    const details = await fetchAnimeBatch(batchIds);
    if (!Array.isArray(details)) throw new Error("Shikimori вернул подробные данные аниме в неожиданном формате.");
    const requested = new Set(batchIds);
    for (const detail of details) {
      const detailId = normalizeAnimeId(detail?.id);
      if (!detail || !detailId || !requested.has(detailId)) throw new Error("Shikimori вернул некорректный ответ при уточнении ID аниме.");
      if (detailsById.has(detailId)) throw new Error("Shikimori вернул повторяющиеся подробные данные аниме: " + detailId);
      detailsById.set(detailId, detail);
    }
    if (resolveMissingIndividually) {
      const missing = batchIds.filter((id) => !detailsById.has(id));
      for (const id of missing) {
        const detail = await fetchAnimeById(id);
        const detailId = normalizeAnimeId(detail?.id);
        if (!detail || detailId !== id) {
          throw new Error("Shikimori не вернул подробные данные для ID аниме " + id + " ни в пакетном запросе, ни в запросе по отдельному ID. Импорт остановлен.");
        }
        detailsById.set(id, detail);
      }
    }
  }

  return rates.map((rate) => {
    const id = normalizeAnimeId(rate.anime.id);
    const detail = detailsById.get(id);
    const myanimelistId = readMyAnimeListId(detail) || readMyAnimeListId(rate.anime) || null;
    return { ...rate, anime: { ...rate.anime, myanimelist_id: myanimelistId } };
  });
}
