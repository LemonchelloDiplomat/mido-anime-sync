import { describe, expect, it } from "vitest";
import { createWatchSourceEntry, findExactAnimeTitleMatches, validateWatchEvent, type WatchEvent } from "../src/core/watch-events.js";
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

  it("accepts AnimeGO's animego.me domain for iframe-originated watch events", () => {
    const normalized = validateWatchEvent({
      ...event,
      sourceUrl: "https://animego.me/anime/example?translation=16",
    });
    expect(normalized.sourceUrl).toBe("https://animego.me/anime/example");
  });

  it("removes query strings and fragments from stored source URLs", () => {
    const normalized = validateWatchEvent({
      ...event,
      sourceUrl: "https://anime-go.org/watch/episode-5?session=private#player",
    });
    expect(normalized.sourceUrl).toBe("https://anime-go.org/watch/episode-5");
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

  it("matches exact normalized aliases and leaves non-exact titles unmatched", () => {
    expect(findExactAnimeTitleMatches([anime], "EXAMPLE   ANIME")).toHaveLength(1);
    expect(findExactAnimeTitleMatches([anime], "Example Anime 2")).toHaveLength(0);
  });

  it("does not move provider timestamps or completed status backwards", () => {
    const existing: AnimeSourceEntry = {
      animeId: anime.id,
      source: "animego",
      status: "COMPLETED",
      progress: 12,
      score: 90,
      favorite: true,
      updatedAt: "2026-11-20T12:00:00.000Z",
      sourceMetadata: {
        lastWatchedAt: "2026-11-20T12:00:00.000Z",
        lastEpisode: 12,
      },
    };
    const next = createWatchSourceEntry(anime, {
      ...event,
      episode: 6,
      observedAt: "2026-11-19T12:00:00.000Z",
    }, existing);

    expect(next.progress).toBe(12);
    expect(next.status).toBe("COMPLETED");
    expect(next.updatedAt).toBe(existing.updatedAt);
    expect(next.sourceMetadata?.lastEpisode).toBe(12);
    expect(next.sourceMetadata?.lastWatchedAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("marks an anime completed when its final episode is recorded", () => {
    const next = createWatchSourceEntry(anime, { ...event, episode: 12 });
    expect(next.status).toBe("COMPLETED");
    expect(next.progress).toBe(12);
  });
});
