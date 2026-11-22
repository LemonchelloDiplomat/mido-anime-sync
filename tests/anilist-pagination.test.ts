import { describe, expect, it, vi } from "vitest";
import {
  ANILIST_LIST_CHUNK_SIZE,
  fetchAniListAnimeList,
} from "../server/anilist-list.mjs";

describe("AniList list chunk pagination", () => {
  it("loads every chunk and merges status/custom list groups without dropping entries", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        Viewer: { mediaListOptions: { scoreFormat: "POINT_10" } },
        MediaListCollection: {
          hasNextChunk: true,
          lists: [
            { name: "Completed", isCustomList: false, entries: [{ id: 1 }, { id: 2 }] },
            { name: "Favorites", isCustomList: true, entries: [{ id: 3 }] },
          ],
        },
      })
      .mockResolvedValueOnce({
        Viewer: { mediaListOptions: { scoreFormat: "POINT_100" } },
        MediaListCollection: {
          hasNextChunk: false,
          lists: [
            { name: "Completed", isCustomList: false, entries: [{ id: 4 }] },
            { name: "Favorites", isCustomList: true, entries: [{ id: 5 }] },
          ],
        },
      });

    const result = await fetchAniListAnimeList({
      request,
      userId: 123,
      accessToken: "token",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { userId: 123, chunk: 1, perChunk: ANILIST_LIST_CHUNK_SIZE },
      { userId: 123, chunk: 2, perChunk: ANILIST_LIST_CHUNK_SIZE },
    ]);
    expect(result.scoreFormat).toBe("POINT_10");
    expect(result.count).toBe(5);
    expect(result.lists).toEqual([
      { name: "Completed", isCustomList: false, entries: [{ id: 1 }, { id: 2 }, { id: 4 }] },
      { name: "Favorites", isCustomList: true, entries: [{ id: 3 }, { id: 5 }] },
    ]);
  });

  it("fails closed when AniList says another chunk exists but returns no entries", async () => {
    const request = vi.fn().mockResolvedValue({
      Viewer: { mediaListOptions: { scoreFormat: "POINT_100" } },
      MediaListCollection: { hasNextChunk: true, lists: [] },
    });

    await expect(fetchAniListAnimeList({
      request,
      userId: 123,
      accessToken: "token",
    })).rejects.toThrow(/текущий фрагмент пуст/);
  });

  it("rejects malformed collection responses instead of silently importing an empty list", async () => {
    const request = vi.fn().mockResolvedValue({ MediaListCollection: { hasNextChunk: false } });

    await expect(fetchAniListAnimeList({
      request,
      userId: 123,
      accessToken: "token",
    })).rejects.toThrow(/неполную коллекцию/);
  });
});
