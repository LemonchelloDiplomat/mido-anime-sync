import { afterEach, describe, expect, it, vi } from "vitest";
import { handleYummyAnimeRequest } from "../server/yummyanime-routes.mjs";
import { normalizeYummyLists } from "../src/services/streaming-tracker-api.js";

function responseCapture(): { status: number; headers: Record<string, string>; body: string; writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void; json(): any } {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = body; },
    json() { return JSON.parse(this.body); },
  };
}

function dependencies(initialTokens: Record<string, any> = {}) {
  const state = { tokens: structuredClone(initialTokens) };
  return {
    state,
    sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    async readJson(req: { body?: unknown }) { return req.body || {}; },
    async readTokens(): Promise<Record<string, any>> { return state.tokens; },
    async writeTokens(tokens: Record<string, any>) { state.tokens = structuredClone(tokens); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YUMMY_APPLICATION_TOKEN;
});

describe("YummyAnime local API routes", () => {
  it("reports an unconfigured state without constructing an API client", async () => {
    delete process.env.YUMMY_APPLICATION_TOKEN;
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/yummyanime/status"),
      dependencies(),
    );
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, connected: false });
  });

  it("reports configuration without exposing credentials or tokens", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const deps = dependencies({ yummyanime: { accessToken: "private-user-token", username: "tester", userId: 42 } });
    const res = responseCapture();
    await handleYummyAnimeRequest({ method: "GET" }, res, new URL("http://127.0.0.1/api/yummyanime/status"), deps);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      connected: true,
      username: "tester",
      userId: 42,
      refreshedAt: null,
    });
    expect(res.body).not.toContain("private-user-token");
  });

  it("proxies catalog search with the application header and no user token", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ response: { anime: [{ anime_id: 7, title: "Test" }], total: 1, limit: 20, offset: 0 } }); },
      options,
    }));
    vi.stubGlobal("fetch", fetcher);
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/yummyanime/search?q=test"),
      dependencies(),
    );
    expect(res.status).toBe(200);
    expect(res.json().anime[0].anime_id).toBe(7);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/search?");
    expect(fetcher.mock.calls[0]?.[1]?.headers["X-Application"]).toBe("public-app-token");
    expect(fetcher.mock.calls[0]?.[1]?.headers.Authorization).toBeUndefined();
  });

  it("keeps YummyAnime title details when video metadata is unavailable", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/anime/42")) return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ response: { anime_id: 42, title: "Test Anime", anime_url: "/catalog/item/42" } }); },
      };
      throw new Error("video metadata unavailable");
    });
    vi.stubGlobal("fetch", fetcher);
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "GET" }, res,
      new URL("http://127.0.0.1/api/yummyanime/anime/42"),
      dependencies(),
    );
    expect(res.status).toBe(200);
    expect(res.json().detail.title).toBe("Test Anime");
    expect(res.json().videos).toEqual([]);
  });

  it("stores only the returned bearer token and account metadata after login", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        async text() { return JSON.stringify({ response: { token: "user-token-123456789", id: 42 } }); },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        async text() { return JSON.stringify({ response: { id: 42, nickname: "tester" } }); },
      });
    vi.stubGlobal("fetch", fetcher);
    const deps = dependencies();
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "POST", body: { login: "tester", password: "not-persisted" } },
      res,
      new URL("http://127.0.0.1/api/yummyanime/login"),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true, username: "tester" });
    expect(deps.state.tokens.yummyanime).toMatchObject({
      accessToken: "user-token-123456789",
      username: "tester",
      userId: 42,
    });
    expect(JSON.stringify(deps.state.tokens)).not.toContain("not-persisted");
  });

  it("returns an explicit captcha challenge instead of retrying login blindly", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 420,
      async text() { return JSON.stringify({ error: "captcha", error_title: "Captcha required" }); },
    })));
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "POST", body: { login: "tester", password: "password" } },
      res,
      new URL("http://127.0.0.1/api/yummyanime/login"),
      dependencies(),
    );
    expect(res.status).toBe(420);
    expect(res.json()).toMatchObject({ captchaRequired: true, siteKey: expect.any(String) });
  });

  it("preserves list ID and label on every returned account row", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (url: string) => {
      const payload = url.endsWith("/profile") ? { response: { id: 42 } }
        : url.endsWith("/users/42/lists") ? { response: [{ id: 1, name: "Watching" }] }
        : { response: [{ anime_id: 7, title: "Test Anime" }] };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    });
    vi.stubGlobal("fetch", fetcher);
    const deps = dependencies({ yummyanime: { accessToken: "private-user-token", userId: 42, refreshedAt: Date.now() } });
    const res = responseCapture();
    await handleYummyAnimeRequest({ method: "GET" }, res, new URL("http://127.0.0.1/api/yummyanime/lists"), deps);
    expect(res.status).toBe(200);
    expect(res.json().entries).toEqual([{ anime_id: 7, title: "Test Anime", list_id: 1, list_name: "Watching" }]);
    expect(normalizeYummyLists(res.json()).map((row) => row.entry.status)).toEqual(["WATCHING"]);
  });

  it("fetches custom account list IDs and unwraps nested list response shapes", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (url: string) => {
      const payload = url.endsWith("/profile") ? { response: { id: 42 } }
        : url.endsWith("/users/42/lists") ? { response: { data: [{ list_id: 12, name: "Смотрю" }] } }
        : { response: { items: [{ anime: { id: 99, title: "Nested account title" } }] } };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    });
    vi.stubGlobal("fetch", fetcher);
    const deps = dependencies({ yummyanime: { accessToken: "private-user-token", userId: 42, refreshedAt: Date.now() } });
    const res = responseCapture();
    await handleYummyAnimeRequest({ method: "GET" }, res, new URL("http://127.0.0.1/api/yummyanime/lists"), deps);
    expect(res.status).toBe(200);
    expect(res.json().entries).toEqual([{ anime: { id: 99, title: "Nested account title" }, anime_id: 99, list_id: 12, list_name: "Смотрю" }]);
    expect(res.json().diagnostics).toMatchObject({ definitionsCount: 1, fetchedRows: 1, lists: [{ listId: 12, rowCount: 1 }] });
    expect(normalizeYummyLists(res.json()).map((row) => row.entry.status)).toEqual(["WATCHING"]);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/users/42/lists/12"))).toBe(true);
  });

  it("ignores non-HTTP poster references without losing imported anime identity", () => {
    const rows = normalizeYummyLists({
      profile: {},
      lists: [],
      count: 1,
      entries: [{
        anime_id: 4873,
        title: "Poster fallback test",
        poster: "/images/poster.jpg",
        poster_url: "javascript:alert(1)",
        user: { list: { list: { id: 0, title: "Смотрю" } } },
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.anime.id).toBe("yummyanime:4873");
    expect(rows[0]?.anime.externalIds.yummyanime).toBe("4873");
    expect(rows[0]?.anime.posterUrl).toBeNull();
  });

  it("imports direct anime rows from the documented user lists endpoint", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (url: string) => {
      const payload = url.endsWith("/profile") ? { response: { id: 42 } }
        : url.endsWith("/users/42/lists") ? { response: [
          {
            anime_id: 101, title: "Санка Рэа", year: 2012,
            user: { rating: 8, list: { is_fav: true, list: { id: 0, title: "Смотрю", href: "/list/0" } } },
          },
          {
            anime_id: 202, title: "Из якудза в идолы", year: 2022,
            user: { rating: 7, list: { is_fav: false, list: { id: 2, title: "Просмотрено", href: "/list/2" } } },
          },
        ] }
        : url.endsWith("/anime/101") ? { response: {
          anime_id: 101, title: "Санка Рэа", original: "Sankarea",
          poster: { huge: "https://img.example/101.jpg" }, type: { shortname: "TV" },
          min_age: { value: 16, title: "16+" }, anime_status: { alias: "released", title: "Вышел" },
          rating: { average: 7.2 }, genres: [{ title: "Романтика" }, { title: "Ужасы" }],
          episodes: { count: 12, aired: 12 }, year: 2012,
          remote_ids: { myanimelist_id: 12345, shikimori_id: 54321 },
        } }
        : url.endsWith("/anime/202") ? { response: {
          anime_id: 202, title: "Из якудза в идолы", poster: { big: "https://img.example/202.jpg" },
          type: { shortname: "TV" }, min_age: { value: 12, title: "12+" },
          anime_status: { alias: "released" }, rating: { average: 6.8 },
          genres: [{ title: "Комедия" }], episodes: { count: 10, aired: 10 }, year: 2022,
        } }
        : { response: {} };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    });
    vi.stubGlobal("fetch", fetcher);
    const deps = dependencies({ yummyanime: { accessToken: "private-user-token", userId: 42, refreshedAt: Date.now() } });
    const res = responseCapture();
    await handleYummyAnimeRequest({ method: "GET" }, res, new URL("http://127.0.0.1/api/yummyanime/lists"), deps);

    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/users/42/lists"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/anime/101"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/anime/202"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/lists/0"))).toBe(false);
    expect(res.json().entries).toHaveLength(2);
    expect(res.json().lists).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 0, name: "Смотрю", rowCount: 1 }),
      expect.objectContaining({ id: 2, name: "Просмотрено", rowCount: 1 }),
    ]));
    expect(normalizeYummyLists(res.json()).map((row) => ({
      title: row.anime.titles.romaji,
      status: row.entry.status,
      favorite: row.entry.favorite,
      score: row.entry.score,
      poster: row.anime.posterUrl,
      genres: row.anime.genres,
      ageRating: row.anime.ageRating,
      format: row.anime.format,
      averageScore: row.anime.averageScore,
      releaseStatus: row.anime.releaseStatus,
      episodes: row.anime.episodes,
      malId: row.anime.externalIds.myanimelist,
    }))).toEqual([
      { title: "Санка Рэа", status: "WATCHING", favorite: true, score: 80, poster: "https://img.example/101.jpg", genres: ["Романтика", "Ужасы"], ageRating: "R17", format: "TV", averageScore: 7.2, releaseStatus: "RELEASED", episodes: 12, malId: "12345" },
      { title: "Из якудза в идолы", status: "COMPLETED", favorite: false, score: 70, poster: "https://img.example/202.jpg", genres: ["Комедия"], ageRating: "PG13", format: "TV", averageScore: 6.8, releaseStatus: "RELEASED", episodes: 10, malId: undefined },
    ]);
    expect(res.json().diagnostics).toMatchObject({ definitionsCount: 2, fetchedRows: 2 });
  });

  it("adds and removes favorites through the documented independent favorite route", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, status: 200, async text() { return JSON.stringify({ response: true }); } }));
    vi.stubGlobal("fetch", fetcher);
    const deps = dependencies({ yummyanime: { accessToken: "private-user-token", refreshedAt: Date.now() } });
    const add = responseCapture();
    await handleYummyAnimeRequest({ method: "POST", body: { animeId: "42", favorite: true } }, add, new URL("http://127.0.0.1/api/yummyanime/favorite"), deps);
    expect(add.status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/anime/42/list/fav");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PUT");
    const remove = responseCapture();
    await handleYummyAnimeRequest({ method: "POST", body: { animeId: "42", favorite: false } }, remove, new URL("http://127.0.0.1/api/yummyanime/favorite"), deps);
    expect(remove.status).toBe(200);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("does not pretend an account list is available when the user is disconnected", async () => {
    process.env.YUMMY_APPLICATION_TOKEN = "public-app-token";
    const res = responseCapture();
    await handleYummyAnimeRequest(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/yummyanime/lists"),
      dependencies(),
    );
    expect(res.status).toBe(401);
    expect(res.json().error).toContain("не подключён");
  });
});
