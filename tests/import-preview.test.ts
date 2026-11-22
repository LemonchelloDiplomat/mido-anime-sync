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

  it("matches a Shikimori entry to an existing AniList/MAL identity through MAL ID", () => {
    const imported = createAnime({
      id: "shikimori:32998",
      externalIds: { shikimori: "32998", myanimelist: "32998" },
    });
    const existing = createAnime({
      id: "mal:32998",
      externalIds: { myanimelist: "32998", anilist: "9876" },
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.matchedAnime?.id).toBe("mal:32998");
    expect(preview.summary).toEqual({ total: 1, new: 0, matched: 1 });
  });

  it("matches all six MAL, AniList and Shikimori import orders through accumulated exact IDs", () => {
    const providers = {
      mal: createAnime({
        id: "mal:1001",
        externalIds: { myanimelist: "1001" },
      }),
      anilist: createAnime({
        id: "anilist:9876",
        externalIds: { anilist: "9876", myanimelist: "1001" },
      }),
      shikimori: createAnime({
        id: "shikimori:32998",
        externalIds: { shikimori: "32998", myanimelist: "1001" },
      }),
    };
    const orders = [
      ["mal", "anilist", "shikimori"],
      ["mal", "shikimori", "anilist"],
      ["anilist", "shikimori", "mal"],
      ["anilist", "mal", "shikimori"],
      ["shikimori", "anilist", "mal"],
      ["shikimori", "mal", "anilist"],
    ] as const;

    for (const order of orders) {
      let merged = providers[order[0]];
      expect(createImportPreview([merged], []).summary).toEqual({
        total: 1, new: 1, matched: 0,
      });

      for (const provider of order.slice(1)) {
        const imported = providers[provider];
        const preview = createImportPreview([imported], [merged]);

        expect(preview.summary).toEqual({ total: 1, new: 0, matched: 1 });
        expect(preview.items[0]?.matchedAnime?.id).toBe(merged.id);

        merged = {
          ...merged,
          externalIds: { ...imported.externalIds, ...merged.externalIds },
        };
      }

      expect(merged.externalIds).toEqual({
        myanimelist: "1001",
        anilist: "9876",
        shikimori: "32998",
      });
    }
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

  it("rejects exact matches with conflicting external IDs", () => {
    const imported = createAnime({
      id: "mal:1",
      externalIds: { myanimelist: "1", anilist: "99" },
    });
    const existing = createAnime({
      id: "anilist:2",
      externalIds: { myanimelist: "1", anilist: "2" },
    });

    expect(() => createImportPreview([imported], [existing])).toThrow(
      "различаются внешние ID сервисов anilist",
    );
  });

  it("matches external IDs after trimming surrounding whitespace", () => {
    const imported = createAnime({
      id: "mal:1",
      externalIds: { myanimelist: " 1 " },
    });
    const existing = createAnime({
      id: "anilist:2",
      externalIds: { myanimelist: "1", anilist: "2" },
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.matchedAnime?.id).toBe("anilist:2");
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
