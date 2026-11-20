import { describe, expect, it } from "vitest";
import {
  parseYummyAccountSnapshot,
  parseYummyDetails,
  parseYummySearch,
  parseYummyWatchHistory,
} from "../src/services/yummyanime.js";

const catalogFixture = {
  response: {
    anime: [{
      anime_id: 10001,
      title: "Sample Chronicle",
      original_title: "サンプル",
      other_titles: ["Sample Chronicle EN"],
      year: 2024,
      type: "tv",
      anime_status: { alias: "ongoing" },
      description: "Synopsis",
      poster: { huge: "https://img.example/poster.jpg" },
      rating: { average: 8.2 },
      episodes: { aired: 12, count: 24 },
      genres: [{ title: "Adventure" }],
      remote_ids: { myanimelist_id: 900001, shikimori_id: 900002 },
    }],
    total: 1,
    limit: 20,
    offset: 0,
  },
};

describe("YummyAnime adapter", () => {
  it("parses search results and keeps verified external IDs", () => {
    const result = parseYummySearch(catalogFixture, 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      provider: "yummyanime",
      externalId: "10001",
      title: "Sample Chronicle",
      year: 2024,
      episodeCount: 24,
    });
    expect(result.items[0]?.url).toContain("yummyani.me");
    expect(result.hasNextPage).toBe(false);
  });

  it("maps episode variants and retains player URLs only in live catalog details", () => {
    const details = parseYummyDetails({
      response: {
        anime_id: 10001,
        anime_url: "https://yummyani.me/catalog/item/sample-chronicle",
        title: "Sample Chronicle",
        episodes: { count: 24 },
      },
    }, {
      response: [
        {
          video_id: 50001,
          number: "1",
          iframe_url: "https://player.example/embed?token=temporary",
          data: { dubbing: "Studio Example", player: "Kodik" },
        },
        {
          video_id: 50002,
          number: "1",
          data: { translation: "Subtitles Team", player: "Sibnet" },
        },
        {
          video_id: 50003,
          number: "2",
          data: { translation: "Subtitles Team", player: "Sibnet" },
        },
      ],
    });
    expect(details.seasons[0]?.episodes.map((episode) => episode.number)).toEqual([1, 2]);
    expect(details.seasons[0]?.episodes[0]?.voiceTracks).toEqual([
      { externalId: "50001", name: "Studio Example", playerUrl: "https://player.example/embed?token=temporary", playerName: "Kodik" },
      { externalId: "50002", name: "Subtitles Team", playerUrl: null, playerName: "Sibnet" },
    ]);
    expect(details.seasons[0]?.episodes[1]?.voiceTracks).toEqual([
      { externalId: "50003", name: "Subtitles Team" },
    ]);
    expect(details.voices.map((voice) => voice.name)).toEqual(["Studio Example", "Subtitles Team"]);
    expect(details.seasons[0]?.episodes[1]?.voiceTracks?.[0]?.playerUrl).toBeNull();
    expect(details.seasons[0]?.episodes[0]?.voiceTracks?.[0]?.playerUrl).toContain("player.example");
  });

  it("imports a YummyAnime list into its own source entries without touching other services", () => {
    const snapshot = parseYummyAccountSnapshot({
      response: [{
        anime_id: 10001,
        title: "Sample Chronicle",
        year: 2024,
        episodes: { count: 24 },
        poster: { huge: "https://img.example/poster.jpg" },
        user: {
          rate: 9,
          list: {
            is_fav: true,
            list: { id: 0, title: "Watching" },
            progress: 5,
          },
        },
        date: 1786000000,
      }],
    });
    expect(snapshot.anime[0]?.id).toBe("yummyanime:10001");
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "yummyanime:10001",
      source: "yummyanime",
      status: "WATCHING",
      progress: 5,
      score: 90,
      favorite: true,
    });
    expect(snapshot.sourceEntries).toEqual(snapshot.entries);
  });

  it("groups remote watch history by title and keeps the furthest episode", () => {
    const snapshot = parseYummyWatchHistory({
      response: [
        { anime_id: 10001, anime_title: "Sample Chronicle", episode: 2, video_id: 50002, date: 1786000000, time: 300, duration: 1440 },
        { anime_id: 10001, anime_title: "Sample Chronicle", episode: 5, video_id: 50005, date: 1786100000, time: 90, duration: 1440 },
      ],
    });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "yummyanime:10001",
      source: "yummyanime",
      status: "WATCHING",
      progress: 5,
    });
    expect(snapshot.entries[0]?.sourceMetadata?.videoIds).toEqual(["50002", "50005"]);
  });

  it("rejects malformed and duplicate account records instead of silently dropping them", () => {
    expect(() => parseYummyAccountSnapshot({ response: [{ title: "Missing ID" }] }))
      .toThrow("без корректного ID");
    expect(() => parseYummyAccountSnapshot({ response: [
      { anime_id: 10001, title: "One", user: { list: { list: { id: 0 } } } },
      { anime_id: 10001, title: "Duplicate", user: { list: { list: { id: 1 } } } },
    ] })).toThrow("повторяющийся ID");
  });
});
