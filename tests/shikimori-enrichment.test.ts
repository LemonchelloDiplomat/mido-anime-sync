import { describe, expect, it, vi } from "vitest";
import { enrichShikimoriAnimeRates, fetchShikimoriAnimeRates, fetchShikimoriAnimeIdentityBatch, getShikimoriIdentityCoverage, SHIKIMORI_ANIME_IDENTITY_QUERY, SHIKIMORI_USER_ANIME_RATES_QUERY } from "../server/shikimori-enrichment.mjs";

function rate(id: number, overrides: { myanimelist_id?: number | null } = {}) {
  return {
    id: id + 1000,
    status: "completed",
    episodes: 12,
    anime: { id, name: "Anime " + id, ...overrides },
  };
}

describe("Shikimori GraphQL batch safety", () => {
  it("does not issue hundreds of individual lookups when batch results omit IDs", async () => {
    const fetchAnimeById = vi.fn(async (id: number) => ({ id, malId: String(id) }));
    const rates = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      anime: { id: index + 1 },
    }));

    const result = await enrichShikimoriAnimeRates(
      rates,
      async () => [],
      fetchAnimeById,
      50,
      { resolveMissingIndividually: false },
    );

    expect(fetchAnimeById).not.toHaveBeenCalled();
    expect(result).toHaveLength(120);
    expect(result.every((rate) => rate.anime.myanimelist_id === null)).toBe(true);
  });
});

describe("Shikimori GraphQL identity lookup", () => {
  it("requests canonical malId values by native Shikimori IDs", async () => {
    const requestGraphql = vi.fn(async () => ({
      animes: [
        { id: "32998", malId: "32998" },
        { id: "60058", malId: "60058" },
      ],
    }));

    const result = await fetchShikimoriAnimeIdentityBatch([32998, 60058], requestGraphql);

    expect(requestGraphql).toHaveBeenCalledExactlyOnceWith(
      SHIKIMORI_ANIME_IDENTITY_QUERY,
      { ids: "32998,60058" },
    );
    expect(result).toEqual([
      { id: "32998", malId: "32998" },
      { id: "60058", malId: "60058" },
    ]);
  });

  it("preserves a null MAL mapping instead of deriving it from the Shikimori ID", async () => {
    const result = await fetchShikimoriAnimeIdentityBatch(
      [101500001],
      async () => ({ animes: [{ id: "101500001", malId: null }] }),
    );

    expect(result).toEqual([{ id: "101500001", malId: null }]);
  });

  it("rejects malformed GraphQL responses", async () => {
    await expect(fetchShikimoriAnimeIdentityBatch(
      [10],
      async () => ({ animes: null }),
    )).rejects.toThrow("GraphQL вернул список аниме в неожиданном формате");
  });

  it("does not issue GraphQL requests for an empty ID list", async () => {
    const requestGraphql = vi.fn();
    await expect(fetchShikimoriAnimeIdentityBatch([], requestGraphql)).resolves.toEqual([]);
    expect(requestGraphql).not.toHaveBeenCalled();
  });
});

describe("Shikimori anime_rates enrichment", () => {
  it("adds MAL IDs from full anime details without mutating the original rates", async () => {
    const input = [rate(10), rate(20, { myanimelist_id: 200 })];
    const before = structuredClone(input);
    const fetchBatch = vi.fn(async (ids: number[]) => ids.map((id) => ({
      id,
      myanimelist_id: id * 10,
    })));

    const result = await enrichShikimoriAnimeRates(input, fetchBatch, async (id) => ({ id }));

    expect(fetchBatch).toHaveBeenCalledExactlyOnceWith([10]);
    expect(result.map((item) => item.anime.myanimelist_id)).toEqual([100, 200]);
    expect(result[0]?.anime.name).toBe("Anime 10");
    expect(input).toEqual(before);
  });

  it("fetches unique anime IDs in batches of at most 50", async () => {
    const input = Array.from({ length: 103 }, (_, index) => rate(index + 1));
    input.push(rate(1), rate(2));
    const fetchBatch = vi.fn(async (ids: number[]) => ids.map((id) => ({
      id,
      myanimelist_id: id + 10000,
    })));

    const result = await enrichShikimoriAnimeRates(input, fetchBatch, async (id) => ({ id }));

    expect(fetchBatch.mock.calls.map(([ids]) => ids.length)).toEqual([50, 50, 3]);
    expect(fetchBatch.mock.calls.flatMap(([ids]) => ids)).toHaveLength(103);
    expect(result).toHaveLength(105);
    expect(result[103]?.anime.myanimelist_id).toBe(10001);
  });

  it("keeps a valid existing MAL ID when the details endpoint has no mapping", async () => {
    const fetchAnimeBatch = vi.fn(async (ids: number[]) => ids.map((id) => ({ id, myanimelist_id: null })));
    const result = await enrichShikimoriAnimeRates(
      [rate(10, { myanimelist_id: 777 })],
      fetchAnimeBatch,
      async (id) => ({ id, myanimelist_id: null }),
    );

    expect(result[0]?.anime.myanimelist_id).toBe(777);
    expect(fetchAnimeBatch).not.toHaveBeenCalled();
  });

  it("stops the import when any requested anime detail is missing", async () => {
    await expect(enrichShikimoriAnimeRates(
      [rate(10), rate(20)],
      async () => [{ id: 10, myanimelist_id: 100 }],
      async () => ({ id: 999 }),
    )).rejects.toThrow("не вернул подробные данные для ID аниме 20");
  });

  it("rejects malformed detail responses instead of returning an unsafe partial list", async () => {
    await expect(enrichShikimoriAnimeRates(
      [rate(10)],
      async () => ({ id: 10, myanimelist_id: 100 }),
      async (id: number) => ({ id }),
    )).rejects.toThrow("подробные данные аниме в неожиданном формате");
  });


  it("resolves IDs omitted by the batch endpoint through the single-anime endpoint", async () => {
    const batch = vi.fn(async () => []);
    const byId = vi.fn(async (id: number) => ({
      id: String(id),
      myanimelist_id: id + 50000,
    }));

    const result = await enrichShikimoriAnimeRates(
      [rate(32998), rate(60058)],
      batch,
      byId,
    );

    expect(batch).toHaveBeenCalledExactlyOnceWith([32998, 60058]);
    expect(byId).toHaveBeenNthCalledWith(1, 32998);
    expect(byId).toHaveBeenNthCalledWith(2, 60058);
    expect(result.map((item) => item.anime.myanimelist_id)).toEqual([82998, 110058]);
  });

  it("falls back only for IDs missing from a partial batch response", async () => {
    const byId = vi.fn(async (id: number) => ({ id, myanimelist_id: id + 100 }));
    const result = await enrichShikimoriAnimeRates(
      [rate(10), rate(20)],
      async () => [{ id: 10, myanimelist_id: 110 }],
      byId,
    );

    expect(byId).toHaveBeenCalledExactlyOnceWith(20);
    expect(result.map((item) => item.anime.myanimelist_id)).toEqual([110, 120]);
  });

  it("stops when the single-anime endpoint returns a different ID", async () => {
    await expect(enrichShikimoriAnimeRates(
      [rate(10)],
      async () => [],
      async () => ({ id: 11, myanimelist_id: 111 }),
    )).rejects.toThrow("не вернул подробные данные для ID аниме 10");
  });

  it("reads numeric-string and alternate MAL ID fields", async () => {
    const result = await enrichShikimoriAnimeRates(
      [
        rate(10, { myanimelist_id: "101" as unknown as number }),
        { ...rate(20), anime: { id: 20, name: "Anime 20", malId: "202" } },
      ],
      async () => [],
      async (id) => ({ id }),
    );

    expect(result.map((item) => item.anime.myanimelist_id)).toEqual([101, 202]);
  });

  it("reports MAL identity coverage without guessing missing IDs", () => {
    const coverage = getShikimoriIdentityCoverage([
      rate(10, { myanimelist_id: 100 }),
      rate(20),
      { ...rate(30), anime: { id: 30, name: "Anime 30", malId: "300" } },
    ]);

    expect(coverage).toEqual({
      total: 3,
      withMyAnimeListId: 2,
      withoutMyAnimeListId: 1,
      sampleMissingAnimeIds: [20],
    });
  });

  it("accepts an empty list without making API requests", async () => {
    const fetchBatch = vi.fn();
    await expect(enrichShikimoriAnimeRates([], fetchBatch, async (id) => ({ id }))).resolves.toEqual([]);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});


describe("Shikimori GraphQL userRates import", () => {
  it("loads all pages with the documented 50-item maximum and keeps native and MAL IDs separate", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: String(index + 1),
      status: "completed",
      score: 8,
      episodes: 12,
      rewatches: 1,
      text: "",
      updatedAt: "2026-11-20T10:00:00Z",
      anime: {
        id: String(101500001 + index),
        malId: String(1000 + index),
        name: "Anime " + index,
        russian: null,
        kind: "tv",
        episodes: 12,
        score: "8.1",
        airedOn: { date: "2020-01-01", year: 2020, month: 1, day: 1 },
        poster: {
          originalUrl: "/uploads/poster/animes/101500001/original.jpg",
          mainUrl: "/uploads/poster/animes/101500001/main.jpg",
        },
      },
    }));
    const secondPage = [{
      id: "51", status: "planned", score: 0, episodes: 0, rewatches: 0,
      anime: { id: "101500051", malId: null, name: "No MAL mapping" },
    }];
    const requestGraphql = vi.fn()
      .mockResolvedValueOnce({ userRates: firstPage })
      .mockResolvedValueOnce({ userRates: secondPage });

    const result = await fetchShikimoriAnimeRates(requestGraphql);

    expect(requestGraphql).toHaveBeenNthCalledWith(1, SHIKIMORI_USER_ANIME_RATES_QUERY, { page: 1, limit: 50 });
    expect(requestGraphql).toHaveBeenNthCalledWith(2, SHIKIMORI_USER_ANIME_RATES_QUERY, { page: 2, limit: 50 });
    expect(result).toHaveLength(51);
    expect(result[0]?.anime.id).toBe(101500001);
    expect(result[0]?.anime.malId).toBe("1000");
    expect(result[0]?.anime.aired_on).toBe("2020-01-01");
    expect(result[0]?.anime.image.original).toBe("/uploads/poster/animes/101500001/original.jpg");
    expect(result[50]?.anime.malId).toBeNull();
    expect(getShikimoriIdentityCoverage(result)).toMatchObject({
      total: 51, withMyAnimeListId: 50, withoutMyAnimeListId: 1,
    });
  });

  it("rejects malformed userRates pages instead of importing a partial list", async () => {
    await expect(fetchShikimoriAnimeRates(async () => ({ userRates: null })))
      .rejects.toThrow("не вернул userRates");
  });

  it("rejects duplicate rate or anime IDs across pages", async () => {
    const duplicate = {
      id: "1", status: "completed", anime: { id: "10", name: "Duplicate" },
    };
    const requestGraphql = vi.fn()
      .mockResolvedValueOnce({ userRates: [duplicate, { ...duplicate, id: "2" }] });
    await expect(fetchShikimoriAnimeRates(requestGraphql, { pageSize: 2 }))
      .rejects.toThrow("повторяющуюся запись");
  });
});
