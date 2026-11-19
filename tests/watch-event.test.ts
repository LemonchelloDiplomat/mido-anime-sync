import { describe, expect, it } from "vitest";
import {
  createLocalWatchProgressEntry,
  findExactAnimeTitleMatches,
  type IncomingWatchEvent,
} from "../src/core/watch-event.js";
import type { AnimeIdentity, AnimeListEntry } from "../src/core/types.js";

const anime: AnimeIdentity = {
  id: "local:1",
  titles: {
    english: "Your Name.",
    romaji: "Kimi no Na wa.",
    native: "君の名は。",
    synonyms: ["Твоё имя"],
  },
  externalIds: {},
  episodes: 1,
};

const event: IncomingWatchEvent = {
  eventId: "event-1",
  provider: "yummyanime",
  title: "Твоё имя",
  episode: 1,
  sourceUrl: "https://yummyani.me/anime/example/episode-1",
  watchedAt: "2026-11-19T12:00:00.000Z",
};

describe("watch event matching and progress", () => {
  it("matches normalized exact aliases but never fuzzy titles", () => {
    expect(findExactAnimeTitleMatches([anime], "ТВОЁ   ИМЯ")).toHaveLength(1);
    expect(findExactAnimeTitleMatches([anime], "Your Name")).toHaveLength(0);
    expect(findExactAnimeTitleMatches([anime], "Your Name.")).toHaveLength(1);
  });

  it("preserves existing local score and favorite while advancing progress", () => {
    const existing: AnimeListEntry = {
      animeId: anime.id,
      source: "local",
      status: "WATCHING",
      progress: 4,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-18T12:00:00.000Z",
      sourceMetadata: { note: "keep" },
    };
    const next = createLocalWatchProgressEntry(anime, existing, {
      ...event,
      episode: 5,
    }, "2026-11-19T12:01:00.000Z");

    expect(next).toMatchObject({
      animeId: anime.id,
      source: "local",
      status: "COMPLETED",
      progress: 5,
      score: 90,
      favorite: true,
      sourceMetadata: {
        note: "keep",
        lastWatchSource: "yummyanime",
        lastWatchSourceUrl: event.sourceUrl,
      },
    });
  });

  it("never decreases local progress when a duplicate or older event arrives", () => {
    const existing: AnimeListEntry = {
      animeId: anime.id,
      source: "local",
      status: "COMPLETED",
      progress: 12,
      score: null,
      favorite: false,
      updatedAt: "2026-11-18T12:00:00.000Z",
    };
    const next = createLocalWatchProgressEntry(anime, existing, event);
    expect(next.progress).toBe(12);
    expect(next.status).toBe("COMPLETED");
  });

  it("rejects invalid episode numbers", () => {
    expect(() => createLocalWatchProgressEntry(anime, undefined, {
      ...event,
      episode: 0,
    })).toThrow("положительным целым числом");
  });
});
