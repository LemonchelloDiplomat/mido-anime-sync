import { describe, expect, it } from "vitest";
import { denormalizeScore, normalizeScore, normalizeStatus } from "../src/core/normalize.js";

describe("normalization", () => {
  it("maps AniList status", () => expect(normalizeStatus("anilist", "CURRENT")).toBe("WATCHING"));
  it("converts score scales", () => {
    expect(normalizeScore(8, 10)).toBe(80);
    expect(denormalizeScore(80, 10)).toBe(8);
  });
  it("preserves unrated state", () => expect(normalizeScore(null, 10)).toBeNull());
  it("does not guess undocumented site status mappings", () => {
    expect(normalizeStatus("animego", "1")).toBeNull();
  });
});
