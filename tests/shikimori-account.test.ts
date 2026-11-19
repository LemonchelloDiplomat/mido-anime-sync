import { describe, expect, it } from "vitest";
import { parseShikimoriAccountList } from "../src/services/shikimori-account.js";

describe("Shikimori account list importer", () => {
  it("normalizes target identity, status, score, progress and rate metadata", () => {
    const snapshot = parseShikimoriAccountList([{
      id: 901,
      target_id: 41,
      target_type: "Anime",
      status: "watching",
      score: 8,
      episodes: 6,
      rewatches: 1,
      text: "A note",
      updated_at: "2026-11-18T12:30:00+03:00",
      target: {
        id: 41,
        name: "Kimi no Na wa.",
        russian: "Твоё имя",
        kind: "movie",
        episodes: 1,
        score: 8.9,
        aired_on: "2016-08-26",
        image: { original: "/system/animes/original/41.jpg" },
      },
    }], "2026-11-19T00:00:00.000Z");

    expect(snapshot.anime[0]).toMatchObject({
      id: "shikimori:41",
      externalIds: { shikimori: "41" },
      titles: { romaji: "Kimi no Na wa.", synonyms: ["Твоё имя"] },
      format: "MOVIE",
      year: 2016,
      episodes: 1,
      averageScore: 8.9,
      posterUrl: "https://shikimori.io/system/animes/original/41.jpg",
    });
    expect(snapshot.entries[0]).toMatchObject({
      animeId: "shikimori:41",
      status: "WATCHING",
      progress: 6,
      score: 80,
      source: "shikimori",
      sourceMetadata: { shikimoriRateId: 901, rewatches: 1, text: "A note" },
    });
  });

  it("rejects duplicate rate IDs and duplicate anime IDs", () => {
    const base = {
      id: 1,
      target_id: 41,
      status: "planned",
      target: { id: 41, name: "Example" },
    };
    expect(() => parseShikimoriAccountList([base, { ...base, target_id: 42, target: { id: 42, name: "Other" } }]))
      .toThrow("повторяющийся ID записи");
    expect(() => parseShikimoriAccountList([base, { ...base, id: 2 }]))
      .toThrow("повторяющийся ID аниме");
  });

  it("rejects unknown statuses instead of silently mapping them", () => {
    expect(() => parseShikimoriAccountList([{
      id: 1,
      target_id: 41,
      status: "unknown",
      target: { id: 41, name: "Example" },
    }])).toThrow("неизвестный статус");
  });
});
