import { afterEach, describe, expect, it, vi } from "vitest";
import { searchAniListAnime } from "../src/services/anilist.js";

const sampleMedia = {
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
  genres: ["Приключения", "Драма", "Фэнтези"],
  coverImage: {
    extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-abc.jpg",
    large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587-abc.jpg",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AniList catalogue search", () => {
  it("does not make a request for an empty or one-character query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(searchAniListAnime(" ")).resolves.toEqual([]);
    await expect(searchAniListAnime("a")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests anime and maps AniList metadata to the local model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: { Page: { media: [sampleMedia] } },
      }), { status: 200 }),
    );

    const result = await searchAniListAnime(" Frieren ");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(request?.body));
    expect(body.variables).toEqual({ search: "Frieren", page: 1, perPage: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "anilist:154587",
      titles: {
        romaji: "Sousou no Frieren",
        english: "Frieren: Beyond Journey's End",
        native: "葬送のフリーレン",
        synonyms: ["Frieren"],
      },
      externalIds: { anilist: "154587", myanimelist: "52991" },
      year: 2023,
      format: "TV",
      episodes: 28,
      genres: ["Приключения", "Драма", "Фэнтези"],
      posterUrl: sampleMedia.coverImage.extraLarge,
      averageScore: 9.1,
      startDate: "2023-09-29",
      releaseStatus: "RELEASED",
    });
  });

  it("uses the season year if the exact start date is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: { Page: { media: [{
          ...sampleMedia,
          startDate: { year: 2024, month: null, day: null },
          seasonYear: 2024,
          status: "RELEASING",
          format: "TV_SHORT",
          averageScore: null,
          idMal: null,
        }] } },
      }), { status: 200 }),
    );

    const [result] = await searchAniListAnime("Frieren");
    expect(result?.year).toBe(2024);
    expect(result?.startDate).toBeNull();
    expect(result?.format).toBe("TV_SHORT");
    expect(result?.releaseStatus).toBe("ONGOING");
    expect(result?.averageScore).toBeNull();
    expect(result?.externalIds.myanimelist).toBeUndefined();
  });

  it("reports AniList rate limiting clearly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    await expect(searchAniListAnime("Frieren")).rejects.toThrow(/через минуту/i);
  });

  it("reports HTTP and GraphQL errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );
    await expect(searchAniListAnime("Frieren")).rejects.toThrow(/HTTP 503/);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Invalid query" }] }), { status: 200 }),
    );
    await expect(searchAniListAnime("Frieren")).rejects.toThrow("Invalid query");
  });

  it("passes an abort signal to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { Page: { media: [] } } }), { status: 200 }),
    );

    await searchAniListAnime("Frieren", controller.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
