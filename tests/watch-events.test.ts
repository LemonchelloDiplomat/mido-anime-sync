import { describe, expect, it } from "vitest";
import {
  createWatchSourceEntry,
  findExactAnimeTitleMatches,
  validateWatchEvent,
} from "../src/core/watch-events.js";
import type { AnimeIdentity, AnimeSourceEntry } from "../src/core/types.js";

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

const event = {
  service: "yummyanime" as const,
  title: "Твоё имя",
  episode: 1,
  sourceUrl: "https://yummyani.me/anime/example/episode-1",
  observedAt: "2026-11-19T12:00:00.000Z",
};

describe("watch event validation and reconciliation", () => {
  it("validates supported watch sources and rejects malformed events", () => {
    expect(validateWatchEvent(event)).toMatchObject(event);
    expect(() => validateWatchEvent({ ...event, service: "unknown" }))
      .toThrow("некорректные данные");
    expect(() => validateWatchEvent({ ...event, episode: 0 }))
      .toThrow("некорректные данные");
    expect(() => validateWatchEvent({ ...event, sourceUrl: "javascript:alert(1)" }))
      .toThrow("некорректные данные");
  });

  it("matches normalized exact aliases without fuzzy guessing", () => {
    expect(findExactAnimeTitleMatches([anime], "ТВОЁ   ИМЯ")).toHaveLength(1);
    expect(findExactAnimeTitleMatches([anime], "Your Name.")).toHaveLength(1);
    expect(findExactAnimeTitleMatches([anime], "Your Name 2")).toHaveLength(0);
  });

  it("stores progress under the watch source and preserves score and favorite", () => {
    const existing: AnimeSourceEntry = {
      animeId: anime.id,
      source: "yummyanime",
      status: "WATCHING",
      progress: 4,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-18T12:00:00.000Z",
      sourceMetadata: { note: "preserve" },
    };
    const next = createWatchSourceEntry(anime, { ...event, episode: 5 }, existing);
    expect(next).toMatchObject({
      animeId: anime.id,
      source: "yummyanime",
      status: "COMPLETED",
      progress: 5,
      score: 90,
      favorite: true,
      sourceMetadata: {
        note: "preserve",
        lastWatchedUrl: event.sourceUrl,
        lastEpisode: 5,
      },
    });
  });

  it("does not lower progress or move the update timestamp backwards", () => {
    const existing: AnimeSourceEntry = {
      animeId: anime.id,
      source: "animego",
      status: "COMPLETED",
      progress: 12,
      score: null,
      favorite: false,
      updatedAt: "2026-11-20T12:00:00.000Z",
      sourceMetadata: { lastWatchedAt: "2026-11-20T12:00:00.000Z", lastEpisode: 12 },
    };
    const next = createWatchSourceEntry(anime, {
      ...event,
      service: "animego",
      episode: 6,
      observedAt: "2026-11-19T12:00:00.000Z",
    }, existing);
    expect(next.progress).toBe(12);
    expect(next.status).toBe("COMPLETED");
    expect(next.updatedAt).toBe(existing.updatedAt);
    expect(next.sourceMetadata?.lastEpisode).toBe(12);
    expect(next.sourceMetadata?.lastWatchedAt).toBe("2026-11-20T12:00:00.000Z");
  });
});
