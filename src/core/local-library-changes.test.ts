import { describe, expect, it } from "vitest";
import type { AnimeListEntry } from "./types.js";
import {
  createLocalLibraryFieldChanges,
  formatLocalLibraryFieldChange,
} from "./local-library-changes.js";

const entry = (overrides: Partial<AnimeListEntry> = {}): AnimeListEntry => ({
  animeId: "anime-1",
  status: "WATCHING",
  progress: 7,
  score: 80,
  favorite: false,
  updatedAt: "2026-11-27T10:00:00.000Z",
  source: "local",
  ...overrides,
});

describe("local library field history", () => {
  it("records only fields that actually changed", () => {
    const changes = createLocalLibraryFieldChanges(
      entry(),
      entry({ status: "COMPLETED", progress: 12, score: 90, favorite: true }),
    );

    expect(changes).toEqual([
      { field: "status", before: "WATCHING", after: "COMPLETED" },
      { field: "progress", before: 7, after: 12 },
      { field: "score", before: 80, after: 90 },
      { field: "favorite", before: false, after: true },
    ]);
  });

  it("records initial values when a title is added", () => {
    const changes = createLocalLibraryFieldChanges(undefined, entry());

    expect(changes).toEqual([
      { field: "status", before: null, after: "WATCHING" },
      { field: "progress", before: null, after: 7 },
      { field: "score", before: null, after: 80 },
      { field: "favorite", before: null, after: false },
    ]);
  });

  it("records the previous values when a title is removed", () => {
    const changes = createLocalLibraryFieldChanges(entry(), undefined);

    expect(changes).toEqual([
      { field: "status", before: "WATCHING", after: null },
      { field: "progress", before: 7, after: null },
      { field: "score", before: 80, after: null },
      { field: "favorite", before: false, after: null },
    ]);
  });

  it("includes shared dates and rewatches when they change", () => {
    const changes = createLocalLibraryFieldChanges(
      entry({ sharedMetadata: { startedAt: null, completedAt: null, rewatchCount: 0 } }),
      entry({ sharedMetadata: { startedAt: "2026-11-01", completedAt: "2026-11-20", rewatchCount: 1 } }),
    );

    expect(changes.map((change) => change.field)).toEqual([
      "startedAt",
      "completedAt",
      "rewatchCount",
    ]);
  });

  it("formats changes in Russian for the activity timeline", () => {
    expect(formatLocalLibraryFieldChange({
      field: "status",
      before: "WATCHING",
      after: "COMPLETED",
    })).toBe("Статус: Смотрю → Просмотрено");
    expect(formatLocalLibraryFieldChange({
      field: "progress",
      before: 7,
      after: 8,
    })).toBe("Прогресс: 7 → 8");
    expect(formatLocalLibraryFieldChange({
      field: "favorite",
      before: false,
      after: true,
    })).toBe("Избранное: Нет → Да");
  });

  it("returns no changes for identical entries", () => {
    expect(createLocalLibraryFieldChanges(entry(), entry())).toEqual([]);
  });
});
