import { describe, expect, it } from "vitest";
import { detectMaxProgressStatusConflicts } from "../src/core/conflicts.js";
import type { AnimeListEntry } from "../src/core/types.js";

function makeEntry(
  source: "myanimelist" | "anilist",
  progress: number,
  status: AnimeListEntry["status"],
): AnimeListEntry {
  return {
    animeId: "anime-1",
    source,
    progress,
    status,
    score: null,
    favorite: false,
    updatedAt: "2026-11-15T12:00:00.000Z",
  };
}

describe("detectMaxProgressStatusConflicts", () => {
  it("detects different statuses at equal maximum progress", () => {
    const entries = [
      makeEntry("myanimelist", 8, "COMPLETED"),
      makeEntry("anilist", 8, "WATCHING"),
    ];

    const conflicts = detectMaxProgressStatusConflicts(entries);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      animeId: "anime-1",
      field: "status",
      localValue: "COMPLETED",
      remoteValue: "WATCHING",
      reason: "concurrent_change",
    });
  });

  it("does not report a conflict when statuses are equal", () => {
    const entries = [
      makeEntry("myanimelist", 8, "WATCHING"),
      makeEntry("anilist", 8, "WATCHING"),
    ];

    expect(detectMaxProgressStatusConflicts(entries)).toHaveLength(0);
  });

  it("ignores status differences at lower progress", () => {
    const entries = [
      makeEntry("myanimelist", 5, "COMPLETED"),
      makeEntry("anilist", 8, "WATCHING"),
    ];

    expect(detectMaxProgressStatusConflicts(entries)).toHaveLength(0);
  });

  it("does not report a conflict for a single entry", () => {
    const entries = [makeEntry("myanimelist", 8, "COMPLETED")];

    expect(detectMaxProgressStatusConflicts(entries)).toHaveLength(0);
  });
});
