const DEFAULT_BATCH_SIZE = 50;

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Fetches complete Shikimori anime records in API-sized batches and copies
 * cross-provider MAL IDs onto the nested anime objects returned by anime_rates.
 *
 * The import must fail closed when a requested detail is missing: returning a
 * partial list could make every unmatched Shikimori title look like a new anime.
 */
export async function enrichShikimoriAnimeRates(
  rates,
  fetchAnimeBatch,
  batchSize = DEFAULT_BATCH_SIZE,
) {
  if (!Array.isArray(rates)) {
    throw new Error("Shikimori вернул список в неожиданном формате.");
  }
  if (typeof fetchAnimeBatch !== "function") {
    throw new Error("Не настроено получение подробных данных Shikimori.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) {
    throw new Error("Размер пакета Shikimori должен быть от 1 до 50.");
  }

  const ids = [];
  const seenIds = new Set();
  for (const rate of rates) {
    const id = rate?.anime?.id;
    if (!isPositiveSafeInteger(id)) {
      throw new Error("Shikimori вернул запись без корректного ID аниме.");
    }
    if (!seenIds.has(id)) {
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
      if (!detail || !isPositiveSafeInteger(detail.id) || !requested.has(detail.id)) {
        throw new Error("Shikimori вернул некорректный ответ при уточнении ID аниме.");
      }
      if (detailsById.has(detail.id)) {
        throw new Error("Shikimori вернул повторяющиеся подробные данные аниме: " + detail.id);
      }
      detailsById.set(detail.id, detail);
    }

    const missing = batchIds.filter((id) => !detailsById.has(id));
    if (missing.length > 0) {
      throw new Error(
        "Shikimori не вернул подробные данные для ID аниме: " + missing.join(", ") +
        ". Импорт остановлен, чтобы не создать ложные дубликаты.",
      );
    }
  }

  return rates.map((rate) => {
    const detail = detailsById.get(rate.anime.id);
    const detailedMalId = detail?.myanimelist_id;
    const existingMalId = rate.anime.myanimelist_id;
    const myanimelistId = isPositiveSafeInteger(detailedMalId)
      ? detailedMalId
      : isPositiveSafeInteger(existingMalId)
        ? existingMalId
        : null;

    return {
      ...rate,
      anime: {
        ...rate.anime,
        myanimelist_id: myanimelistId,
      },
    };
  });
}
