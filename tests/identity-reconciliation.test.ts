import { describe, expect, it } from "vitest";
import { findExactIdentityDuplicatePairs } from "../src/core/identity-reconciliation.js";
import type { AnimeIdentity } from "../src/core/types.js";

function anime(
  id: string,
  externalIds: AnimeIdentity["externalIds"],
): AnimeIdentity {
  return {
    id,
    titles: { english: "Example Anime", synonyms: [] },
    externalIds,
  };
}

describe("exact identity reconciliation", () => {
  it("finds records sharing an exact ID across imports", () => {
    const mal = anime("mal:100", { myanimelist: "100" });
    const anilist = anime("anilist:200", { myanimelist: "100", anilist: "200" });

    expect(findExactIdentityDuplicatePairs([mal, anilist])).toEqual([
      { first: mal, second: anilist, sharedServices: ["myanimelist"] },
    ]);
  });

  it("does not use similar titles as identity evidence", () => {
    const first = anime("mal:1", { myanimelist: "1" });
    const second = anime("mal:2", { myanimelist: "2" });

    expect(findExactIdentityDuplicatePairs([first, second])).toEqual([]);
  });

  it("normalizes surrounding whitespace in external IDs", () => {
    const first = anime("mal:1", { myanimelist: " 123 " });
    const second = anime("anilist:2", { myanimelist: "123" });

    expect(findExactIdentityDuplicatePairs([first, second])).toHaveLength(1);
  });

  it("reports every pair in a multi-record collision for manual review", () => {
    const first = anime("one", { myanimelist: "123" });
    const second = anime("two", { myanimelist: "123" });
    const third = anime("three", { myanimelist: "123" });

    expect(findExactIdentityDuplicatePairs([first, second, third])).toHaveLength(3);
  });
});
