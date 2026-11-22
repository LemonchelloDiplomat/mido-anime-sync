import { describe, expect, it } from "vitest";
import { parseMyAnimeListApiList } from "../src/services/myanimelist-account.js";

describe("MyAnimeList account list importer", () => {
  it("normalizes remote catalog and personal list fields", () => {
    const snapshot = parseMyAnimeListApiList([{
      node: {
        id: 52991,
        title: "Sousou no Frieren",
        main_picture: { large: "https://example.com/frieren.jpg" },
        alternative_titles: {
          en: "Frieren: Beyond Journey's End",
          ja: "葬送のフリーレン",
          synonyms: ["Frieren"],
        },
        start_date: "2023-09-29",
        media_type: "tv",
        status: "finished_airing",
        num_episodes: 28,
        mean: 9.3,
        genres: [{ id: 1, name: "Adventure" }],
        rating: "pg_13",
      },
      list_status: {
        status: "watching",
        score: 9,
        num_episodes_watched: 12,
        is_rewatching: false,
        updated_at: "2026-11-16T12:00:00+00:00",
        num_times_rewatched: 1,
        tags: ["fantasy"],
      },
    }], "2026-11-17T00:00:00.000Z");

    expect(snapshot.anime[0]).toMatchObject({
      id: "mal:52991",
      titles: {
        romaji: "Sousou no Frieren",
        english: "Frieren: Beyond Journey's End",
        native: "葬送のフリーレン",
        synonyms: ["Frieren"],
      },
      externalIds: { myanimelist: "52991" },
      year: 2023,
      format: "TV",
      episodes: 28,
      averageScore: 9.3,
      posterUrl: "https://example.com/frieren.jpg",
      ageRating: "PG13",
      releaseStatus: "RELEASED",
    });
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "mal:52991",
      status: "WATCHING",
      progress: 12,
      score: 90,
      source: "myanimelist",
      sharedMetadata: { rewatchCount: 1 },
      sourceMetadata: { originalStatus: "watching", originalScore: 9, timesRewatched: 1 },
    });
    expect(snapshot.sourceEntries).toEqual(snapshot.entries);
  });

  it("preserves rewatching as a distinct local status", () => {
    const snapshot = parseMyAnimeListApiList([{
      node: { id: 1, title: "Cowboy Bebop" },
      list_status: { status: "watching", score: 0, num_episodes_watched: 3, is_rewatching: true },
    }]);
    expect(snapshot.entries[0]?.status).toBe("REWATCHING");
  });

  it("rejects duplicate remote IDs", () => {
    const entry = { node: { id: 1, title: "One" }, list_status: { status: "completed", score: 10, num_episodes_watched: 1 } };
    expect(() => parseMyAnimeListApiList([entry, entry])).toThrow(/повторяющийся ID/);
  });
});
