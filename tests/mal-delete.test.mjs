import { describe, expect, it, vi } from "vitest";
import { deleteMyAnimeListEntry } from "../server/mal-delete.mjs";

describe("MyAnimeList deletion request", () => {
  it("sends DELETE to the anime list-status endpoint with OAuth headers", async () => {
    const requestJson = vi.fn().mockResolvedValue([]);
    const result = await deleteMyAnimeListEntry({
      animeId: 12345,
      accessToken: "test-access-token",
      clientId: "test-client-id",
      requestJson,
    });

    expect(result).toEqual([]);
    expect(requestJson).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledWith(
      "https://api.myanimelist.net/v2/anime/12345/my_list_status",
      {
        method: "DELETE",
        headers: {
          "X-MAL-CLIENT-ID": "test-client-id",
          Authorization: "Bearer test-access-token",
          Accept: "application/json",
        },
      },
    );
  });

  it.each([0, -1, 1.5, Number.NaN, "not-an-id"])(
    "rejects invalid anime ID %s without making a request",
    async (animeId) => {
      const requestJson = vi.fn();

      await expect(deleteMyAnimeListEntry({
        animeId,
        accessToken: "test-access-token",
        clientId: "test-client-id",
        requestJson,
      })).rejects.toThrow("Некорректный MyAnimeList ID");

      expect(requestJson).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing access token without making a request", async () => {
    const requestJson = vi.fn();

    await expect(deleteMyAnimeListEntry({
      animeId: 12345,
      accessToken: "",
      clientId: "test-client-id",
      requestJson,
    })).rejects.toThrow("MyAnimeList ещё не подключён");

    expect(requestJson).not.toHaveBeenCalled();
  });

  it("preserves HTTP errors from MyAnimeList", async () => {
    const apiError = Object.assign(new Error("Unauthorized"), { status: 401 });
    const requestJson = vi.fn().mockRejectedValue(apiError);

    await expect(deleteMyAnimeListEntry({
      animeId: 12345,
      accessToken: "test-access-token",
      clientId: "test-client-id",
      requestJson,
    })).rejects.toBe(apiError);
  });
});
