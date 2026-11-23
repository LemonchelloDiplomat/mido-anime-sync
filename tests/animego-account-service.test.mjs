import { describe, expect, it, vi } from "vitest";
import {
  connectAnimeGoAccount,
  disconnectAnimeGoAccount,
  fetchAnimeGoAccountLists,
  getAnimeGoAccountStatus,
} from "../server/animego-account-service.mjs";

const LOGIN_HTML = `
<html><body>
  <form action="/logout" method="post"><input type="hidden" name="_csrf_token" value="logout"></form>
  <form action="/login" method="post">
    <input type="text" name="_username">
    <input type="password" name="_password">
    <input type="checkbox" name="_remember_me" value="1">
    <input type="hidden" name="_csrf_token" value="csrf-value">
  </form>
</body></html>`;

const AUTH_HOME = '<html data-user="{&quot;id&quot;:1367030,&quot;username&quot;:&quot;test-user&quot;}"><body>profile</body></html>';

function createStore(initial = {}) {
  let tokens = structuredClone(initial);
  return {
    readTokens: vi.fn(async () => structuredClone(tokens)),
    writeTokens: vi.fn(async (next) => { tokens = structuredClone(next); }),
    snapshot: () => structuredClone(tokens),
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

describe("AnimeGO account service", () => {
  it("logs in using the observed form, follows same-origin redirects and stores only the session", async () => {
    const store = createStore({ mal: { accessToken: "keep-existing-token" } });
    const fetcher = vi.fn(async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/login" && options.method === "GET") {
        return response(LOGIN_HTML, 200, { "set-cookie": "preauth=one; Path=/; HttpOnly" });
      }
      if (parsed.pathname === "/login" && options.method === "POST") {
        const body = String(options.body);
        expect(body).toContain("_username=test-user");
        expect(body).toContain("_password=secret-pass");
        expect(body).toContain("_csrf_token=csrf-value");
        expect(body).toContain("_remember_me=on");
        expect(options.headers.Cookie).toContain("preauth=one");
        return response("", 302, {
          Location: "/",
          "set-cookie": "animego_session=session-value; Path=/; HttpOnly; Secure",
        });
      }
      if (parsed.pathname === "/" && options.method === "GET") {
        expect(options.headers.Cookie).toContain("animego_session=session-value");
        return response(AUTH_HOME);
      }
      throw new Error("Unexpected upstream request: " + parsed.pathname);
    });

    const result = await connectAnimeGoAccount({
      username: "test-user",
      password: "secret-pass",
      rememberMe: true,
    }, { ...store, fetcher });

    expect(result).toMatchObject({
      provider: "animego",
      adapterAvailable: true,
      status: { connected: true, state: "connected", accountLabel: "test-user" },
    });
    const saved = store.snapshot();
    expect(saved.mal.accessToken).toBe("keep-existing-token");
    expect(saved.streamingAccounts.animego.userId).toBe("1367030");
    expect(saved.streamingAccounts.animego.cookies).toContainEqual(["animego_session", "session-value"]);
    expect(JSON.stringify(saved)).not.toContain("secret-pass");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not save a session when the account page does not confirm login", async () => {
    const store = createStore();
    const fetcher = vi.fn(async (url, options) => {
      if (new URL(String(url)).pathname === "/login" && options.method === "GET") {
        return response(LOGIN_HTML);
      }
      if (new URL(String(url)).pathname === "/login" && options.method === "POST") {
        return response("", 302, { Location: "/" });
      }
      return response("<html><body>not signed in</body></html>");
    });

    await expect(connectAnimeGoAccount({
      username: "wrong-user",
      password: "wrong-password",
    }, { ...store, fetcher })).rejects.toThrow("не подтвердил авторизацию");
    expect(store.writeTokens).not.toHaveBeenCalled();
  });

  it("rejects off-origin redirects and never forwards the session cookie", async () => {
    const store = createStore();
    const fetcher = vi.fn(async (url, options) => {
      if (new URL(String(url)).pathname === "/login") {
        if (options.method === "GET") return response(LOGIN_HTML, 200, { "set-cookie": "preauth=secret; Path=/" });
        return response("", 302, { Location: "https://evil.example/collect" });
      }
      throw new Error("Unexpected request");
    });

    await expect(connectAnimeGoAccount({
      username: "test-user",
      password: "secret-pass",
    }, { ...store, fetcher })).rejects.toThrow("другой домен");
    expect(store.writeTokens).not.toHaveBeenCalled();
  });

  it("validates a stored session and clears it when the account is no longer signed in", async () => {
    const store = createStore({
      streamingAccounts: {
        animego: {
          cookies: [["session", "expired"]],
          userId: "1367030",
          accountLabel: "test-user",
          connectedAt: "2026-11-23T00:00:00.000Z",
        },
      },
    });
    const fetcher = vi.fn(async () => response("<html><body>anonymous</body></html>"));

    const result = await getAnimeGoAccountStatus({ ...store, fetcher });

    expect(result.status.state).toBe("disconnected");
    expect(store.snapshot().streamingAccounts).toBeUndefined();
  });

  it("disconnects without touching other provider credentials", async () => {
    const store = createStore({
      mal: { accessToken: "mal-token" },
      streamingAccounts: { animego: { cookies: [["session", "secret"]], userId: "1" } },
    });

    const result = await disconnectAnimeGoAccount(store);

    expect(result.status.state).toBe("disconnected");
    expect(store.snapshot()).toEqual({ mal: { accessToken: "mal-token" } });
  });

  it("reads all six personal list types sequentially without changing the stored session", async () => {
    const store = createStore({
      streamingAccounts: {
        animego: {
          cookies: [["session", "valid-session"]],
          userId: "1367030",
          accountLabel: "test-user",
          connectedAt: "2026-11-23T00:00:00.000Z",
        },
      },
    });
    const fetcher = vi.fn(async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(AUTH_HOME);
      if (parsed.pathname !== "/profile/1367030" || parsed.searchParams.get("type") === null) {
        throw new Error("Unexpected list route: " + parsed.pathname);
      }
      const type = parsed.searchParams.get("type");
      return response(`
        <div class="user-mylist__item" data-mylist-id="${type}">
          <div class="user-mylist__title"><a href="/anime/test-title-${type}">Test title ${type}</a></div>
          <img src="https://animego.me/poster-${type}.jpg" alt="Test title ${type}">
        </div>
      `);
    });

    const result = await fetchAnimeGoAccountLists({
      ...store,
      fetcher,
      intervalMs: 0,
    });

    expect(result.total).toBe(6);
    expect(result.lists).toHaveLength(6);
    expect(result.items.map((item) => item.listType)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.items.map((item) => item.title)).toEqual([
      "Test title 1", "Test title 2", "Test title 3",
      "Test title 4", "Test title 5", "Test title 6",
    ]);
    expect(store.snapshot().streamingAccounts.animego.userId).toBe("1367030");
  });

  it("requires a connected account before fetching personal lists", async () => {
    const store = createStore();
    await expect(fetchAnimeGoAccountLists({ ...store, fetcher: vi.fn() }))
      .rejects.toThrow("Сначала подключи аккаунт AnimeGO");
  });
});
