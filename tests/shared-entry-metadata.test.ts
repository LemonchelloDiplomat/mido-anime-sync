import { describe, expect, it } from "vitest";
import { mergeSharedMetadataIntoProviderMetadata } from "../src/core/shared-entry-metadata.js";

describe("shared tracker entry metadata", () => {
  const shared = {
    rewatchCount: 3,
    startedAt: "2025-01-02",
    completedAt: "2025-02-03",
  };

  it("maps shared fields to MAL while preserving MAL-only metadata", () => {
    expect(mergeSharedMetadataIntoProviderMetadata("mal", shared, {
      tags: ["favorite"],
      comments: "MAL-only comment",
      priority: 1,
      rewatchValue: 2,
    })).toEqual({
      tags: ["favorite"],
      comments: "MAL-only comment",
      priority: 1,
      rewatchValue: 2,
      timesRewatched: 3,
      startDate: "2025-01-02",
      finishDate: "2025-02-03",
    });
  });

  it("maps shared fields to AniList without replacing AniList-only notes", () => {
    expect(mergeSharedMetadataIntoProviderMetadata("anilist", shared, {
      notes: "AniList-only note",
      customField: "preserve",
    })).toEqual({
      notes: "AniList-only note",
      customField: "preserve",
      repeat: 3,
      startedAt: "2025-01-02",
      completedAt: "2025-02-03",
    });
  });

  it("maps only the rewatch count to Shikimori", () => {
    expect(mergeSharedMetadataIntoProviderMetadata("shikimori", shared, {
      text: "Shikimori-only note",
    })).toEqual({
      text: "Shikimori-only note",
      rewatches: 3,
    });
  });

  it("passes explicit null dates to AniList so they are cleared remotely", () => {
    expect(mergeSharedMetadataIntoProviderMetadata("anilist", {
      rewatchCount: 2,
      startedAt: null,
      completedAt: null,
    }, {
      notes: "keep this note",
      repeat: 1,
      startedAt: "2024-01-01",
      completedAt: "2024-02-01",
    })).toEqual({
      notes: "keep this note",
      repeat: 2,
      startedAt: null,
      completedAt: null,
    });
  });

  it("ignores invalid shared values instead of overwriting provider data", () => {
    expect(mergeSharedMetadataIntoProviderMetadata("mal", {
      rewatchCount: -1,
      startedAt: "2025-02-30",
      completedAt: "not-a-date",
    }, {
      timesRewatched: 2,
      startDate: "2024-01-01",
      finishDate: "2024-02-01",
    })).toEqual({
      timesRewatched: 2,
      startDate: "2024-01-01",
      finishDate: "2024-02-01",
    });
  });

  it("does not mutate the existing provider metadata", () => {
    const existing = { tags: ["one"] };
    const result = mergeSharedMetadataIntoProviderMetadata("mal", shared, existing);
    expect(existing).toEqual({ tags: ["one"] });
    expect(result).not.toBe(existing);
  });
});
