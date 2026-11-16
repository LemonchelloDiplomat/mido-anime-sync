import { describe, expect, it } from "vitest";
import { createImportPreview } from "../src/core/import-preview.js";
import type { AnimeIdentity } from "../src/core/types.js";

function createAnime(overrides: Partial<AnimeIdentity> = {}): AnimeIdentity {
  return {
    id: crypto.randomUUID(),
    titles: {
      english: "Death Note",
      romaji: "Death Note",
      synonyms: [],
    },
    externalIds: {},
    year: 2006,
    format: "TV",
    episodes: 37,
    ...overrides,
  };
}

describe("import preview", () => {
  it("marks an anime as new when no exact ID match exists", () => {
    const imported = createAnime({ id: "mal:1" });
    const existing = createAnime({ id: "anilist:2" });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[0]?.matchedAnime).toBeNull();
    expect(preview.summary).toEqual({ total: 1, new: 1, matched: 0 });
  });

  it("matches the same internal ID", () => {
    const imported = createAnime({ id: "mal:1" });
    const existing = createAnime({ id: "mal:1" });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.matchedAnime?.id).toBe("mal:1");
  });

  it("matches records by the same service external ID", () => {
    const imported = createAnime({
      id: "mal:1",
      externalIds: { myanimelist: "1" },
    });
    const existing = createAnime({
      id: "anilist:2",
      externalIds: { myanimelist: "1", anilist: "2" },
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.matchedAnime?.id).toBe("anilist:2");
  });

  it("does not merge similar titles when external IDs differ", () => {
    const imported = createAnime({
      id: "mal:season-2",
      titles: { romaji: "5-toubun no Hanayome ∬", synonyms: [] },
      externalIds: { myanimelist: "season-2" },
    });
    const existing = createAnime({
      id: "mal:season-1",
      titles: { romaji: "5-toubun no Hanayome", synonyms: [] },
      externalIds: { myanimelist: "season-1" },
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[0]?.matchedAnime).toBeNull();
  });

  it("allows different seasons with similar names in the same import file", () => {
    const first = createAnime({
      id: "mal:season-1",
      titles: { romaji: "5-toubun no Hanayome", synonyms: [] },
      externalIds: { myanimelist: "season-1" },
    });
    const second = createAnime({
      id: "mal:season-2",
      titles: { romaji: "5-toubun no Hanayome ∬", synonyms: [] },
      externalIds: { myanimelist: "season-2" },
    });

    const preview = createImportPreview([first, second], []);

    expect(preview.summary).toEqual({ total: 2, new: 2, matched: 0 });
    expect(preview.items.every((item) => item.status === "new")).toBe(true);
  });

  it("rejects an exact duplicate external ID inside the imported file", () => {
    const first = createAnime({
      id: "first",
      externalIds: { myanimelist: "123" },
    });
    const second = createAnime({
      id: "second",
      externalIds: { myanimelist: "123" },
    });

    expect(() => createImportPreview([first, second], [])).toThrow(
      "В импортируемом файле повторяется внешний ID myanimelist:123",
    );
  });

  it("rejects ambiguous exact matches in the existing library", () => {
    const imported = createAnime({
      id: "mal:1",
      externalIds: { myanimelist: "1" },
    });
    const first = createAnime({
      id: "anilist:2",
      externalIds: { myanimelist: "1" },
    });
    const second = createAnime({
      id: "local:3",
      externalIds: { myanimelist: "1" },
    });

    expect(() => createImportPreview([imported], [first, second])).toThrow(
      "В библиотеке найдено несколько записей с одним и тем же внешним ID",
    );
  });

  it("does not modify original anime records", () => {
    const imported = createAnime({ id: "imported" });
    const existing = createAnime({ id: "existing" });
    const importedBefore = structuredClone(imported);
    const existingBefore = structuredClone(existing);

    createImportPreview([imported], [existing]);

    expect(imported).toEqual(importedBefore);
    expect(existing).toEqual(existingBefore);
  });
});
