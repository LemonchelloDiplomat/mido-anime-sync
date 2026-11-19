import { deleteMyAnimeListEntry } from "./mal-delete.mjs";

export async function handleMalDelete(
  body,
  { readTokens, getAccessToken, clientId, requestJson },
) {
  const id = Number(body?.externalId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return {
      status: 400,
      body: { error: "Некорректный MyAnimeList ID для удаления." },
    };
  }

  try {
    const tokens = await readTokens();
    const accessToken = await getAccessToken(tokens);
    await deleteMyAnimeListEntry({
      animeId: id,
      accessToken,
      clientId,
      requestJson,
    });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return {
      status: error?.status || 502,
      body: { error: error?.message || "Не удалось удалить запись MyAnimeList." },
    };
  }
}
