import { describe, expect, it } from "vitest";
import { parseAnimeGoMyListResponse } from "../server/animego-mylist-parser.mjs";

const pageTwoHtml = [
  '<turbo-stream action="before" targets="#profile-my-list-page-2"><template>',
  '<div id="profile-my-list-entry-51630488" class="user-mylist__item d-flex gap-3" data-mylist-id="51630488">',
  '<div class="d-flex flex-fill"><div class="d-grid">',
  '<a class="user-mylist__picture" href="/anime/voyennaya-khronika-romelii-4033">',
  '<img class="image__img" src="https://img.cdngos.com/v/250x350/anime/poster-one" alt="Военная хроника Ромелии"></a></div>',
  '<div class="user-mylist__body"><div class="user-mylist__title">',
  '<a href="/anime/voyennaya-khronika-romelii-4033">Военная хроника Ромелии</a>',
  '<div class="user-profile__status"><span>онгоинг</span></div></div>',
  '<div class="fw-lighter small">Romelia Senki</div>',
  '<a class="link-secondary" href="/anime/voyennaya-khronika-romelii-4033#player">Продолжить 7 / 8 (24)</a>',
  '<div class="user-mylist-rating" data-rating="6010"><span data-rating-value></span></div>',
  '</div></div></div>',
  '<div id="profile-my-list-entry-51421317" class="user-mylist__item" data-mylist-id="51421317">',
  '<div class="user-mylist__title"><a href="/anime/dazhe-u-studsoveta-yest-kosyaki-3821">Даже у студсовета есть косяки!</a></div>',
  '<div class="fw-lighter small">Seitokai ni mo Ana wa Aru!</div>',
  '<img src="https://img.cdngos.com/posters/two.jpg" alt="Даже у студсовета есть косяки!">',
  '<a href="/anime/dazhe-u-studsoveta-yest-kosyaki-3821#player">Продолжить 3 / 12</a></div>',
  '</template></turbo-stream>',
  '<turbo-stream action="replace" targets="#profile-my-list-page-2"><template>',
  '<turbo-frame id="profile-my-list-page-3" class="profile-my-list__page-frame" src="/user/mylist/123456/3?type=1" loading="lazy"></turbo-frame>',
  '</template></turbo-stream>',
].join("");

describe("AnimeGO personal-list Turbo Stream parser", () => {
  it("extracts cards, identifiers, titles, posters, release labels and playback progress", () => {
    const result = parseAnimeGoMyListResponse(pageTwoHtml, {
      listType: 1,
      baseUrl: "https://animego.me/user/mylist/123456/2?type=1",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      provider: "animego",
      listEntryId: "51630488",
      animeId: "4033",
      animeSlug: "voyennaya-khronika-romelii-4033",
      title: "Военная хроника Ромелии",
      alternativeTitle: "Romelia Senki",
      posterUrl: "https://img.cdngos.com/v/250x350/anime/poster-one",
      listType: 1,
      releaseStatus: "онгоинг",
      episodesWatched: 7,
      episodesTotal: 8,
    });
    expect(result.items[1]).toMatchObject({
      listEntryId: "51421317",
      animeId: "3821",
      title: "Даже у студсовета есть косяки!",
      alternativeTitle: "Seitokai ni mo Ana wa Aru!",
      episodesWatched: 3,
      episodesTotal: 12,
    });
  });

  it("discovers the next Turbo Frame URL and frame id", () => {
    const result = parseAnimeGoMyListResponse(pageTwoHtml, {
      baseUrl: "https://animego.me/user/mylist/123456/2?type=1",
    });
    expect(result.nextPageFrameId).toBe("profile-my-list-page-3");
    expect(result.nextPageUrl).toBe("/user/mylist/123456/3?type=1");
  });

  it("does not interpret opaque data-rating values as the user's score", () => {
    const result = parseAnimeGoMyListResponse(pageTwoHtml);
    expect(result.items[0]).not.toHaveProperty("rating");
    expect(result.items[0]).not.toHaveProperty("score");
  });

  it("preserves the requested list type without guessing a status mapping", () => {
    const result = parseAnimeGoMyListResponse(pageTwoHtml, { listType: 5 });
    expect(result.items.every((item) => item.listType === 5)).toBe(true);
  });

  it("ignores invalid cards and deduplicates repeated list-entry IDs", () => {
    const html = [
      '<div class="user-mylist__item" data-mylist-id="1"><div class="user-mylist__title"><a href="/anime/valid-title-100">Valid title</a></div></div>',
      '<div class="user-mylist__item" data-mylist-id="1"><div class="user-mylist__title"><a href="/anime/duplicate-title-101">Duplicate</a></div></div>',
      '<div class="user-mylist__item" data-mylist-id="2"><div class="user-mylist__title"><a href="https://evil.example/anime/external-102">External</a></div></div>',
      '<div class="user-mylist__item" data-mylist-id="3"><div class="user-mylist__title">Missing title link</div></div>',
    ].join("");
    const result = parseAnimeGoMyListResponse(html);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Valid title");
  });

  it("rejects non-AnimeGO response origins, invalid list types and oversized responses", () => {
    expect(() => parseAnimeGoMyListResponse("", { baseUrl: "https://evil.example/" })).toThrow(/animego.me/);
    expect(() => parseAnimeGoMyListResponse("", { listType: 0 })).toThrow(/list type/);
    expect(() => parseAnimeGoMyListResponse("x".repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MB/);
  });

  it("ignores off-site and malformed next-page frames", () => {
    const html = '<turbo-frame id="profile-my-list-page-3" src="https://evil.example/user/mylist/1/3?type=1"></turbo-frame>';
    const result = parseAnimeGoMyListResponse(html);
    expect(result.nextPageFrameId).toBeNull();
    expect(result.nextPageUrl).toBeNull();
  });
});
