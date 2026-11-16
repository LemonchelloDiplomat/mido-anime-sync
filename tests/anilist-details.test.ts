import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAniListAnimeDetails } from "../src/services/anilist.js";

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

const relatedFilm = {
  ...frieren,
  id: 200001,
  idMal: null,
  title: {
    romaji: "Sousou no Frieren: Movie",
    english: "Frieren Movie",
    native: null,
  },
  format: "MOVIE",
  episodes: 1,
};

afterEach(() => vi.restoreAllMocks());

describe("AniList anime details", () => {
  it("loads description, production facts and related anime", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          Media: {
            ...frieren,
            description: "An elf mage begins a journey after the hero's party.",
            bannerImage: "https://example.com/banner.jpg",
            season: "FALL",
            source: "MANGA",
            duration: 24,
            studios: { nodes: [{ name: "Madhouse" }] },
            relations: {
              edges: [
                { relationType: "SEQUEL", node: { ...relatedFilm, type: "ANIME" } },
                { relationType: "ADAPTATION", node: { ...relatedFilm, id: 300001, type: "MANGA" } },
              ],
            },
          },
        },
      }), { status: 200 }),
    );

    const result = await fetchAniListAnimeDetails(154587);

    expect(result.anime.id).toBe("anilist:154587");
    expect(result.description).toContain("elf mage");
    expect(result.bannerImage).toBe("https://example.com/banner.jpg");
    expect(result.season).toBe("FALL");
    expect(result.source).toBe("MANGA");
    expect(result.duration).toBe(24);
    expect(result.studios).toEqual(["Madhouse"]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      relationType: "SEQUEL",
      anime: { id: "anilist:200001", format: "MOVIE" },
    });
  });

  it("rejects invalid AniList IDs without a network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fetchAniListAnimeDetails(0)).rejects.toThrow(/Некорректный ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing titles and API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { Media: null } }), { status: 200 }),
    );
    await expect(fetchAniListAnimeDetails(154587)).rejects.toThrow(/не нашёл это аниме/i);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "GraphQL failed" }] }), { status: 200 }),
    );
    await expect(fetchAniListAnimeDetails(154587)).rejects.toThrow("GraphQL failed");
  });
});
