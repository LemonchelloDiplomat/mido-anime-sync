import { describe, expect, it } from "vitest";
import { parseShikimoriAccountList } from "../src/services/shikimori-account.js";

describe("Shikimori account list importer", () => {
  it("parses the actual anime_rates response and keeps rate/anime IDs separate", () => {
    const snapshot = parseShikimoriAccountList([{
      id: 219694778,
      status: "completed",
      score: 0,
      episodes: 12,
      rewatches: 0,
      text: null,
      updated_at: "2026-11-11T17:25:08.296+03:00",
      anime: {
        id: 32998,
        name: "91 Days",
        russian: "91 день",
        image: {
          original: "/system/animes/original/32998.jpg?1711937952",
          preview: "/system/animes/preview/32998.jpg?1711937952",
          x96: "/system/animes/x96/32998.jpg?1711937952",
          x48: "/system/animes/x48/32998.jpg?1711937952",
        },
        url: "/animes/32998-91-days",
        kind: "tv",
        score: "7.82",
        status: "released",
        episodes: 12,
        episodes_aired: 12,
        aired_on: "2016-07-09",
        released_on: "2016-10-01",
      },
    }], "2026-11-19T00:00:00.000Z");

    expect(snapshot.anime).toHaveLength(1);
    expect(snapshot.anime[0]).toMatchObject({
      id: "shikimori:32998",
      externalIds: { shikimori: "32998" },
      titles: { romaji: "91 Days", synonyms: ["91 день"] },
      format: "TV",
      year: 2016,
      startDate: "2016-07-09",
      episodes: 12,
      averageScore: 7.82,
      posterUrl: "https://shikimori.io/system/animes/original/32998.jpg?1711937952",
    });
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "shikimori:32998",
      status: "COMPLETED",
      progress: 12,
      score: null,
      source: "shikimori",
      updatedAt: "2026-11-11T14:25:08.296Z",
      sourceMetadata: { shikimoriRateId: 219694778, rewatches: 0, text: "" },
    });
    expect(snapshot.sourceEntries).toEqual(snapshot.entries);
  });

  it("normalizes all supported statuses and user scores", () => {
    const statuses = [
      ["watching", "WATCHING"],
      ["rewatching", "REWATCHING"],
      ["completed", "COMPLETED"],
      ["on_hold", "ON_HOLD"],
      ["dropped", "DROPPED"],
      ["planned", "PLANNING"],
    ] as const;

    for (const [status, expected] of statuses) {
      const snapshot = parseShikimoriAccountList([{
        id: 100 + statuses.findIndex(([value]) => value === status),
        status,
        score: 8,
        episodes: 6,
        anime: { id: 41 + statuses.findIndex(([value]) => value === status), name: "Example" },
      }]);
      expect(snapshot.entries[0]?.status).toBe(expected);
      expect(snapshot.entries[0]?.score).toBe(80);
    }
  });

  it("accepts an empty account list", () => {
    const snapshot = parseShikimoriAccountList([], "2026-11-19T00:00:00.000Z");
    expect(snapshot.anime).toEqual([]);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.sourceEntries).toEqual([]);
  });

  it("rejects duplicate rate IDs and duplicate anime IDs", () => {
    const base = {
      id: 1,
      status: "planned",
      anime: { id: 41, name: "Example" },
    };
    expect(() => parseShikimoriAccountList([
      base,
      { ...base, anime: { id: 42, name: "Other" } },
    ])).toThrow("повторяющийся ID записи");
    expect(() => parseShikimoriAccountList([
      base,
      { ...base, id: 2 },
    ])).toThrow("повторяющийся ID аниме");
  });

  it("rejects malformed records without anime identity", () => {
    expect(() => parseShikimoriAccountList([{
      id: 1,
      status: "planned",
      anime: { id: 0, name: "Example" },
    }])).toThrow("некорректная запись");
    expect(() => parseShikimoriAccountList([{
      id: 1,
      status: "planned",
      anime: { id: 41, name: " " },
    }])).toThrow("некорректная запись");
  });

  it("rejects unknown statuses instead of silently mapping them", () => {
    expect(() => parseShikimoriAccountList([{
      id: 1,
      status: "unknown",
      anime: { id: 41, name: "Example" },
    }])).toThrow("неизвестный статус");
  });
});
