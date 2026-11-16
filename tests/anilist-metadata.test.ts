import { afterEach, describe, expect, it, vi } from "vitest";
import { aniListMetadataProvider } from "../src/services/anilist.js";
import type { AnimeIdentity } from "../src/core/types.js";

const frieren = {
  id: 154587,
  idMal: 52991,
  title: {
    romaji: "Sousou no Frieren",
    english: "Frieren: Beyond Journey's End",
    native: "葬送のフリーレン",
  },
  synonyms: ["Frieren"],
  format: "TV",
  status: "FINISHED",
  episodes: 28,
  seasonYear: 2023,
  startDate: { year: 2023, month: 9, day: 29 },
  averageScore: 91,
  genres: ["Adventure", "Drama", "Fantasy"],
  coverImage: { extraLarge: "https://example.com/frieren.jpg", large: null },
};

function makeAnime(id: string, malId: string): AnimeIdentity {
  return {
    id,
    titles: { romaji: `MAL title ${malId}`, synonyms: [] },
    externalIds: { myanimelist: malId },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AniList metadata provider", () => {
  it("looks up exact MAL IDs in one batch and reports matches and missing records", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          anime0: frieren,
          anime1: null,
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const batches: Array<{
      completed: number;
      total: number;
      matched: number;
      missing: number;
      matches: Array<{ animeId: string; metadata: AnimeIdentity }>;
    }> = [];

    await aniListMetadataProvider.enrich(
      [makeAnime("mal:52991", "52991"), makeAnime("mal:99999", "99999")],
      { onBatch: (batch) => { batches.push(batch); } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.query).toContain("Media(idMal: $malId0, type: ANIME)");
    expect(request.variables).toEqual({ malId0: 52991, malId1: 99999 });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      completed: 2,
      total: 2,
      matched: 1,
      missing: 1,
    });
    expect(batches[0]?.matches[0]).toMatchObject({
      animeId: "mal:52991",
      metadata: {
        id: "anilist:154587",
        externalIds: { anilist: "154587", myanimelist: "52991" },
        posterUrl: "https://example.com/frieren.jpg",
        genres: ["Приключения", "Драма", "Фэнтези"],
        averageScore: 9.1,
      },
    });
  });

  it("does not search by titles or send malformed MAL IDs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const invalid = makeAnime("local:1", "not-a-number");

    await aniListMetadataProvider.enrich([invalid]);

    expect(fetchMock).not.toHaveBeenCalled();
  });


  it("skips entries already resolved to AniList so a retry resumes remaining records", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { anime0: frieren } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const alreadyEnriched = {
      ...makeAnime("mal:52991", "52991"),
      externalIds: { myanimelist: "52991", anilist: "154587" },
      posterUrl: "https://example.com/frieren.jpg",
    };
    const pending = makeAnime("mal:99999", "99999");

    await aniListMetadataProvider.enrich([alreadyEnriched, pending]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.variables).toEqual({ malId0: 99999 });
  });

  it("isolates a missing MAL ID after a batch-level HTTP 404 and keeps valid matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));

    const requestedIds: number[][] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, number>;
        };
        const ids = Object.values(request.variables);
        requestedIds.push(ids);

        if (ids.includes(99999)) {
          return new Response(JSON.stringify({
            errors: [{
              message: "Not Found.",
              status: 404,
              locations: [{ line: 3, column: 1 }],
            }],
            data: Object.fromEntries(ids.map((_, index) => [`anime${index}`, null])),
          }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const data: Record<string, typeof frieren> = {};
        ids.forEach((malId, index) => {
          data[`anime${index}`] = { ...frieren, id: 200000 + malId, idMal: malId };
        });
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const batches: Array<{
      completed: number;
      total: number;
      matched: number;
      missing: number;
      matches: Array<{ animeId: string; metadata: AnimeIdentity }>;
    }> = [];

    const enrichment = aniListMetadataProvider.enrich(
      [makeAnime("mal:52991", "52991"), makeAnime("mal:99999", "99999")],
      { onBatch: (batch) => { batches.push(batch); } },
    );
    await vi.runAllTimersAsync();
    await enrichment;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestedIds).toEqual([[52991, 99999], [52991], [99999]]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      completed: 2,
      total: 2,
      matched: 1,
      missing: 1,
    });
    expect(batches[0]?.matches[0]?.animeId).toBe("mal:52991");
  });

  it("splits large libraries into batches of twenty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, number>;
        };
        const data: Record<string, typeof frieren> = {};
        for (const [index, malId] of Object.values(request.variables).entries()) {
          data[`anime${index}`] = { ...frieren, id: 200000 + malId, idMal: malId };
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const anime = Array.from({ length: 21 }, (_, index) =>
      makeAnime(`mal:${index + 1}`, String(index + 1)),
    );
    const progress: number[] = [];

    await aniListMetadataProvider.enrich(anime, {
      onBatch: (batch) => { progress.push(batch.completed); },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([20, 21]);
  });
});
