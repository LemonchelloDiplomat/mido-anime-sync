const MAL_API = "https://api.myanimelist.net/v2";

export async function deleteMyAnimeListEntry({
  animeId,
  accessToken,
  clientId,
  requestJson,
}) {
  const id = Number(animeId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Некорректный MyAnimeList ID для удаления.");
  }
  if (!accessToken) {
    throw new Error("MyAnimeList ещё не подключён.");
  }
  if (typeof requestJson !== "function") {
    throw new TypeError("Не передана функция HTTP-запроса MyAnimeList.");
  }

  return requestJson(MAL_API + "/anime/" + id + "/my_list_status", {
    method: "DELETE",
    headers: {
      "X-MAL-CLIENT-ID": clientId,
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
    },
  });
}
