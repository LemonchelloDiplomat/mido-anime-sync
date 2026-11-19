import { describe, expect, it } from "vitest";
import {
  getProviderLabel,
  getProviderServiceId,
  providerSupportsFavorite,
  providerUsesTenPointScore,
  SYNC_PROVIDER_DEFINITIONS,
} from "../src/core/provider-capabilities.js";

describe("sync provider capabilities", () => {
  it("maps each account provider to its canonical service ID", () => {
    expect(getProviderServiceId("mal")).toBe("myanimelist");
    expect(getProviderServiceId("anilist")).toBe("anilist");
    expect(getProviderServiceId("shikimori")).toBe("shikimori");
  });

  it("declares field and deletion capabilities explicitly", () => {
    expect(providerSupportsFavorite("anilist")).toBe(true);
    expect(providerSupportsFavorite("mal")).toBe(false);
    expect(providerSupportsFavorite("shikimori")).toBe(false);
    expect(providerUsesTenPointScore("mal")).toBe(true);
    expect(providerUsesTenPointScore("shikimori")).toBe(true);
    expect(providerUsesTenPointScore("anilist")).toBe(false);
    expect(SYNC_PROVIDER_DEFINITIONS.shikimori.capabilities).toMatchObject({
      read: true,
      create: true,
      updateStatus: true,
      updateProgress: true,
      updateScore: true,
      updateFavorite: false,
      delete: true,
      importFile: false,
      exportFile: false,
    });
    expect(getProviderLabel("shikimori")).toBe("Shikimori");
  });
});
