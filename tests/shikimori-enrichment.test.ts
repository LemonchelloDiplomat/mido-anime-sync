import { describe, expect, it, vi } from "vitest";
import { enrichShikimoriAnimeRates } from "../server/shikimori-enrichment.mjs";

function rate(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: id + 1000,
    status: "completed",
    episodes: 12,
    anime: { id, name: "Anime " + id, ...overrides },
  };
}

describe("Shikimori anime_rates enrichment", () => {
  it("adds MAL IDs from full anime details without mutating the original rates", async () => {
    const input = [rate(10), rate(20, { myanimelist_id: 200 })];
    const before = structuredClone(input);
    const fetchBatch = vi.fn(async (ids: number[]) => ids.map((id) => ({
      id,
      myanimelist_id: id * 10,
    })));

    const result = await enrichShikimoriAnimeRates(input, fetchBatch);

    expect(fetchBatch).toHaveBeenCalledExactlyOnceWith([10, 20]);
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

    const result = await enrichShikimoriAnimeRates(input, fetchBatch);

    expect(fetchBatch.mock.calls.map(([ids]) => ids.length)).toEqual([50, 50, 3]);
    expect(fetchBatch.mock.calls.flatMap(([ids]) => ids)).toHaveLength(103);
    expect(result).toHaveLength(105);
    expect(result[103]?.anime.myanimelist_id).toBe(10001);
  });

  it("keeps a valid existing MAL ID when the details endpoint has no mapping", async () => {
    const result = await enrichShikimoriAnimeRates(
      [rate(10, { myanimelist_id: 777 })],
      async (ids) => ids.map((id) => ({ id, myanimelist_id: null })),
    );

    expect(result[0]?.anime.myanimelist_id).toBe(777);
  });

  it("stops the import when any requested anime detail is missing", async () => {
    await expect(enrichShikimoriAnimeRates(
      [rate(10), rate(20)],
      async () => [{ id: 10, myanimelist_id: 100 }],
    )).rejects.toThrow("не вернул подробные данные для ID аниме: 20");
  });

  it("rejects malformed detail responses instead of returning an unsafe partial list", async () => {
    await expect(enrichShikimoriAnimeRates(
      [rate(10)],
      async () => ({ id: 10, myanimelist_id: 100 }),
    )).rejects.toThrow("подробные данные аниме в неожиданном формате");
  });

  it("accepts an empty list without making API requests", async () => {
    const fetchBatch = vi.fn();
    await expect(enrichShikimoriAnimeRates([], fetchBatch)).resolves.toEqual([]);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});
