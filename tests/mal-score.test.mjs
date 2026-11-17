import { describe, expect, it } from "vitest";
import { toMyAnimeListScore } from "../server/mal-score.mjs";

describe("MyAnimeList score conversion", () => {
  it("preserves an empty score as zero", () => {
    expect(toMyAnimeListScore(null)).toBe(0);
    expect(toMyAnimeListScore(0)).toBe(0);
  });

  it("rounds normalized scores to the nearest MAL integer score", () => {
    expect(toMyAnimeListScore(84)).toBe(8);
    expect(toMyAnimeListScore(85)).toBe(9);
    expect(toMyAnimeListScore(95)).toBe(10);
  });

  it("rejects scores outside the normalized 0–100 range", () => {
    expect(() => toMyAnimeListScore(-1)).toThrow(RangeError);
    expect(() => toMyAnimeListScore(101)).toThrow(RangeError);
  });
});
