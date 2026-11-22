const DEFAULT_BATCH_SIZE = 50;

function normalizeAnimeId(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\\d+$/.test(value.trim())) return null;
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

/**
 * Enriches anime_rates with complete anime records. The list endpoint is used
 * in batches first; any IDs omitted by that endpoint are resolved through the
 * documented single-anime endpoint before import can continue.
 */
export async function enrichShikimoriAnimeRates(
  rates,
  fetchAnimeBatch,
  fetchAnimeById,
  batchSize = DEFAULT_BATCH_SIZE,
) {
  if (!Array.isArray(rates)) {
    throw new Error("Shikimori вернул список в неожиданном формате.");
  }
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
    if (!id) {
      throw new Error("Shikimori вернул запись без корректного ID аниме.");
    }
    // A usable MAL ID is already enough for cross-provider matching.
    // Avoid extra Shikimori requests for entries that already carry it.
    if (readMyAnimeListId(rate.anime) === null && !seenIds.has(id)) {
      seenIds.add(id);
      ids.push(id);
    }
  }

  const detailsById = new Map();
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batchIds = ids.slice(offset, offset + batchSize);
    const details = await fetchAnimeBatch(batchIds);
    if (!Array.isArray(details)) {
      throw new Error("Shikimori вернул подробные данные аниме в неожиданном формате.");
    }

    const requested = new Set(batchIds);
    for (const detail of details) {
      const detailId = normalizeAnimeId(detail?.id);
      if (!detail || !detailId || !requested.has(detailId)) {
        throw new Error("Shikimori вернул некорректный ответ при уточнении ID аниме.");
      }
      if (detailsById.has(detailId)) {
        throw new Error("Shikimori вернул повторяющиеся подробные данные аниме: " + detailId);
      }
      detailsById.set(detailId, detail);
    }

    // Some Shikimori REST responses omit entries for a multi-ID query. Resolve
    // only those omissions via /api/animes/:id instead of failing the whole list.
    const missing = batchIds.filter((id) => !detailsById.has(id));
    for (const id of missing) {
      const detail = await fetchAnimeById(id);
      const detailId = normalizeAnimeId(detail?.id);
      if (!detail || detailId !== id) {
        throw new Error(
          "Shikimori не вернул подробные данные для ID аниме " + id +
          " ни в пакетном запросе, ни в запросе по отдельному ID. Импорт остановлен.",
        );
      }
      detailsById.set(id, detail);
    }
  }

  return rates.map((rate) => {
    const id = normalizeAnimeId(rate.anime.id);
    const detail = detailsById.get(id);
    const detailedMalId = readMyAnimeListId(detail);
    const existingMalId = readMyAnimeListId(rate.anime);
    const myanimelistId = detailedMalId || existingMalId || null;

    return {
      ...rate,
      anime: {
        ...rate.anime,
        myanimelist_id: myanimelistId,
      },
    };
  });
}
