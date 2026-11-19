import { describe, expect, it } from "vitest";
import { createWatchSourceEntry, validateWatchEvent, type WatchEvent } from "../src/core/watch-events.js";
import type { AnimeIdentity, AnimeSourceEntry } from "../src/core/types.js";

const anime: AnimeIdentity = {
  id: "anilist:100",
  titles: { english: "Example Anime", synonyms: [] },
  externalIds: { anilist: "100" },
  episodes: 12,
};

const event: WatchEvent = {
  service: "animego",
  title: "Example Anime",
  episode: 5,
  sourceUrl: "https://anime-go.org/anime/example/episode-5",
  observedAt: "2026-11-19T12:00:00.000Z",
  currentTimeSeconds: 1200,
  durationSeconds: 1400,
};

describe("watch source events", () => {
  it("validates and normalizes a browser watch event", () => {
    expect(validateWatchEvent(event)).toEqual(event);
  });

  it("rejects unsupported services, unsafe URLs and invalid episode numbers", () => {
    expect(() => validateWatchEvent({ ...event, service: "unknown" })).toThrow("некорректные данные");
    expect(() => validateWatchEvent({ ...event, sourceUrl: "javascript:alert(1)" })).toThrow("некорректные данные");
    expect(() => validateWatchEvent({ ...event, sourceUrl: "https://evil.example/watch" })).toThrow("некорректные данные");
    expect(() => validateWatchEvent({ ...event, episode: 0 })).toThrow("некорректные данные");
  });

  it("creates a source entry without overwriting a higher existing progress", () => {
    const existing: AnimeSourceEntry = {
      animeId: anime.id,
      source: "animego",
      status: "WATCHING",
      progress: 8,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-18T12:00:00.000Z",
      sourceMetadata: { custom: "preserve" },
    };
    const next = createWatchSourceEntry(anime, event, existing);

    expect(next).toMatchObject({
      animeId: anime.id,
      source: "animego",
      status: "WATCHING",
      progress: 8,
      score: 90,
      favorite: true,
      sourceMetadata: {
        custom: "preserve",
        lastEpisode: 5,
        lastWatchedUrl: event.sourceUrl,
        lastPositionSeconds: 1200,
      },
    });
  });

  it("marks an anime completed when its final episode is recorded", () => {
    const next = createWatchSourceEntry(anime, { ...event, episode: 12 });
    expect(next.status).toBe("COMPLETED");
    expect(next.progress).toBe(12);
  });
});
