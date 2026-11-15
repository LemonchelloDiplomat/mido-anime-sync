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
  it("marks an anime as new when no match exists", () => {
    const imported = createAnime({
      id: "imported",
      titles: {
        english: "Naruto",
        synonyms: [],
      },
    });

    const preview = createImportPreview([imported], []);

    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[0]?.selectedMatch).toBeNull();
    expect(preview.summary.new).toBe(1);
  });

  it("automatically matches one high-confidence candidate", () => {
    const imported = createAnime({ id: "imported" });
    const existing = createAnime({ id: "existing" });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.selectedMatch?.id).toBe("existing");
    expect(preview.summary.matched).toBe(1);
  });

  it("requires review when the only match has low confidence", () => {
    const imported = createAnime({ id: "imported" });
    const existing = createAnime({
      id: "existing",
      year: 2015,
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("review");
    expect(preview.items[0]?.selectedMatch).toBeNull();
    expect(preview.summary.review).toBe(1);
  });

  it("requires review when multiple candidates exist", () => {
    const imported = createAnime({ id: "imported" });
    const first = createAnime({ id: "first" });
    const second = createAnime({ id: "second" });

    const preview = createImportPreview([imported], [first, second]);

    expect(preview.items[0]?.status).toBe("review");
    expect(preview.items[0]?.matches).toHaveLength(2);
    expect(preview.items[0]?.selectedMatch).toBeNull();
  });

  it("matches records with the same internal ID", () => {
    const imported = createAnime({ id: "same-id" });
    const existing = createAnime({ id: "same-id" });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[0]?.selectedMatch?.id).toBe("same-id");
    expect(preview.items[0]?.matches[0]?.score).toBe(100);
  });

  it("requires review when the same internal ID has conflicting titles", () => {
    const imported = createAnime({
      id: "same-id",
      titles: {
        english: "Naruto",
        synonyms: [],
      },
    });

    const existing = createAnime({
      id: "same-id",
      titles: {
        english: "Death Note",
        synonyms: [],
      },
    });

    const preview = createImportPreview([imported], [existing]);

    expect(preview.items[0]?.status).toBe("review");
    expect(preview.items[0]?.selectedMatch).toBeNull();
    expect(preview.items[0]?.matches[0]?.reasons).toContain(
      "Названия различаются",
    );
  });

  it("detects duplicate internal IDs inside the imported file", () => {
    const first = createAnime({ id: "duplicate-id" });
    const second = createAnime({ id: "duplicate-id" });

    const preview = createImportPreview([first, second], []);

    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[1]?.status).toBe("review");
    expect(preview.items[1]?.matches[0]?.anime.id).toBe("duplicate-id");
    expect(preview.items[0]?.duplicateInImport).toBe(false);
    expect(preview.items[1]?.duplicateInImport).toBe(true);
    expect(preview.summary).toEqual({
      total: 2,
      new: 1,
      matched: 0,
      review: 1,
    });
  });

  it("detects possible title duplicates inside the imported file", () => {
    const first = createAnime({ id: "first" });
    const second = createAnime({ id: "second" });

    const preview = createImportPreview([first, second], []);

    expect(preview.items[0]?.status).toBe("new");
    expect(preview.items[1]?.status).toBe("review");
    expect(preview.items[1]?.matches).toHaveLength(1);
    expect(preview.items[1]?.matches[0]?.anime.id).toBe("first");
    expect(preview.items[0]?.duplicateInImport).toBe(false);
    expect(preview.items[1]?.duplicateInImport).toBe(true);
    expect(preview.summary.review).toBe(1);
  });

  it("does not automatically match a duplicate import even if it matches the library", () => {
    const first = createAnime({ id: "first" });
    const second = createAnime({ id: "second" });
    const existing = createAnime({ id: "existing" });

    const preview = createImportPreview([first, second], [existing]);

    expect(preview.items[0]?.status).toBe("matched");
    expect(preview.items[1]?.status).toBe("review");
    expect(preview.items[1]?.selectedMatch).toBeNull();
  });

  it("creates correct totals for several imported anime", () => {
    const imported = [
      createAnime({
        id: "new",
        titles: { english: "Naruto", synonyms: [] },
      }),
      createAnime({ id: "matched" }),
      createAnime({
        id: "review",
        year: 2015,
        titles: { english: "Bleach", synonyms: [] },
      }),
    ];

    const existing = [
      createAnime({ id: "existing-match" }),
      createAnime({
        id: "existing-review",
        year: 2006,
        titles: { english: "Bleach", synonyms: [] },
      }),
    ];

    const preview = createImportPreview(imported, existing);

    expect(preview.summary).toEqual({
      total: 3,
      new: 1,
      matched: 1,
      review: 1,
    });
  });

  it("does not modify the original anime records", () => {
    const imported = createAnime({ id: "imported" });
    const existing = createAnime({ id: "existing" });

    const importedBefore = structuredClone(imported);
    const existingBefore = structuredClone(existing);

    createImportPreview([imported], [existing]);

    expect(imported).toEqual(importedBefore);
    expect(existing).toEqual(existingBefore);
  });
});
