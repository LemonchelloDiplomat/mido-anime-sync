import { afterEach, describe, expect, it, vi } from "vitest";
import { handleYummyAnimeRequest } from "../server/yummyanime-routes.mjs";

function responseCapture() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
    json() { return JSON.parse(this.body); },
  };
}

function dependencies(initialTokens = {}) {
  const state = { tokens: structuredClone(initialTokens) };
  return {
    state,
    sendJson(res, status, body) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    async readJson(req) { return req.body || {}; },
    async readTokens() { return state.tokens; },
    async writeTokens(tokens) { state.tokens = structuredClone(tokens); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YUMMY_APPLICATION_TOKEN;
});

describe("YummyAnime local API routes", () => {
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
