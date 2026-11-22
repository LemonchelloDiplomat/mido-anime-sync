import { describe, expect, it } from "vitest";
import {
  STREAMING_PROVIDER_IDS,
  STREAMING_PROVIDER_CAPABILITIES,
  getStreamingProviderCapabilities,
  isStreamingProviderId,
  toStreamingServiceId,
  type StreamingProviderCapabilities,
  type StreamingTitleDetails,
} from "../src/services/streaming-provider.js";

describe("streaming provider contracts", () => {
  it("registers the three intended streaming websites without changing catalog sync providers", () => {
    expect(STREAMING_PROVIDER_IDS).toEqual(["animego", "yummyanime", "anixart"]);
    expect(isStreamingProviderId("animego")).toBe(true);
    expect(isStreamingProviderId("yummyanime")).toBe(true);
    expect(isStreamingProviderId("anixart")).toBe(true);
    expect(isStreamingProviderId("anilist")).toBe(false);
    expect(isStreamingProviderId("unknown")).toBe(false);
  });

  it("declares account and progress capabilities only where implemented", () => {
    expect(STREAMING_PROVIDER_CAPABILITIES.yummyanime).toMatchObject({
      accountConnection: true, listImport: true, listWrite: true,
      watchProgressRead: false, watchProgressWrite: false,
    });
    expect(getStreamingProviderCapabilities("animego")).toMatchObject({
      catalogSearch: true, titleDetails: true,
      accountConnection: false, listImport: false, listWrite: false,
      watchProgressRead: true, watchProgressWrite: false,
    });
    expect(getStreamingProviderCapabilities("anixart")).toMatchObject({
      catalogSearch: true, titleDetails: true,
      accountConnection: false, listImport: true, listWrite: false,
      watchProgressRead: true, watchProgressWrite: false,
    });
    const copy = getStreamingProviderCapabilities("animego");
    copy.limitations?.push("mutated");
    expect(STREAMING_PROVIDER_CAPABILITIES.animego.limitations).not.toContain("mutated");
  });

  it("maps streaming provider IDs to existing source-entry IDs", () => {
    expect(toStreamingServiceId("animego")).toBe("animego");
    expect(toStreamingServiceId("yummyanime")).toBe("yummyanime");
    expect(toStreamingServiceId("anixart")).toBe("anixart");
  });

  it("allows catalog and account capabilities to be declared independently", () => {
    const catalogOnly: StreamingProviderCapabilities = {
      catalogSearch: true,
      titleDetails: true,
      seasonsAndEpisodes: true,
      voiceTracks: false,
      accountConnection: false,
      listImport: false,
      listWrite: false,
      watchProgressRead: false,
      watchProgressWrite: false,
      limitations: ["Личный список недоступен через подтверждённый интерфейс."],
    };
    expect(catalogOnly.catalogSearch).toBe(true);
    expect(catalogOnly.accountConnection).toBe(false);
    expect(catalogOnly.listImport).toBe(false);
  });

  it("models title details without requiring every provider to expose every field", () => {
    const details: StreamingTitleDetails = {
      provider: "anixart",
      externalId: "7004",
      url: "https://anixart.site/7004-title.html",
      title: "Example",
      alternativeTitles: [],
      seasons: [{
        number: 1,
        episodes: [{
          externalId: "episode-1",
          number: 1,
          url: "https://anixart.site/7004-title.html",
        }],
      }],
      voices: [],
    };
    expect(details.seasons[0]?.episodes[0]?.number).toBe(1);
    expect(details.voices).toEqual([]);
  });
});
