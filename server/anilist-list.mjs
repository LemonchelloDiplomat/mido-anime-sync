export const ANILIST_LIST_CHUNK_SIZE = 500;
export const ANILIST_LIST_MAX_CHUNKS = 100;

export async function fetchAniListAnimeList({ request, userId, accessToken }) {
  if (typeof request !== "function") throw new TypeError("AniList request callback is required.");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Некорректный ID пользователя AniList.");

  const query = `query UserAnimeList($userId: Int!, $chunk: Int!, $perChunk: Int!) {
    Viewer { mediaListOptions { scoreFormat } }
    MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: $perChunk) {
      hasNextChunk
      lists {
        name
        isCustomList
        isSplitCompletedList
        entries {
          id status score progress repeat notes updatedAt
          startedAt { year month day }
          completedAt { year month day }
          media {
            id idMal isFavourite
            title { romaji english native }
            synonyms format status episodes seasonYear
            startDate { year month day }
            averageScore genres
            coverImage { extraLarge large }
          }
        }
      }
    }
  }`;

  const listsByKey = new Map();
  let scoreFormat = "POINT_100";
  let totalEntries = 0;

  for (let chunk = 1; chunk <= ANILIST_LIST_MAX_CHUNKS; chunk += 1) {
    const data = await request(query, {
      userId,
      chunk,
      perChunk: ANILIST_LIST_CHUNK_SIZE,
    }, accessToken);

    const collection = data?.MediaListCollection;
    if (!collection || !Array.isArray(collection.lists)) {
      throw new Error("AniList вернул неполную коллекцию списка.");
    }

    if (chunk === 1) scoreFormat = data.Viewer?.mediaListOptions?.scoreFormat || "POINT_100";

    let chunkEntries = 0;
    for (const list of collection.lists) {
      if (!list || typeof list.name !== "string" || !Array.isArray(list.entries)) {
        throw new Error("AniList вернул некорректную группу списка.");
      }
      const key = JSON.stringify([list.name, Boolean(list.isCustomList), Boolean(list.isSplitCompletedList)]);
      let target = listsByKey.get(key);
      if (!target) {
        target = { ...list, entries: [] };
        listsByKey.set(key, target);
      }
      target.entries.push(...list.entries);
      chunkEntries += list.entries.length;
    }

    totalEntries += chunkEntries;
    if (!collection.hasNextChunk) {
      return {
        lists: [...listsByKey.values()],
        scoreFormat,
        count: totalEntries,
      };
    }
    if (chunkEntries === 0) {
      throw new Error("AniList сообщил о следующем фрагменте, но текущий фрагмент пуст.");
    }
  }

  throw new Error("Список AniList слишком большой: достигнут лимит фрагментов.");
}
