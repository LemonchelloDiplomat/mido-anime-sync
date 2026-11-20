import { describe, expect, it } from "vitest";
import { normalizeCatalogQuery } from "../src/i18n.js";

describe("application locale and multilingual catalog search", () => {
  it("normalizes spacing without stripping Japanese or other native scripts", () => {
    expect(normalizeCatalogQuery("  葬送のフリーレン   第２期  ")).toBe("葬送のフリーレン 第2期");
    expect(normalizeCatalogQuery("  Naruto   Shippuden  ")).toBe("Naruto Shippuden");
    expect(normalizeCatalogQuery("  Наруто   Шиппуден  ")).toBe("Наруто Шиппуден");
  });
});
