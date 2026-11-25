import { describe, expect, it } from "vitest";
import {
  StreamingAccountManager,
  type StreamingAccountAdapter,
} from "../src/services/streaming-account-manager.js";
import {
  StreamingAccountSessionVault,
} from "../src/services/streaming-account-session.js";

function createStore() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async remove(key: string) { values.delete(key); },
  };
}

describe("streaming account manager", () => {
  it("connects without exposing session material in status", async () => {
    const manager = new StreamingAccountManager(new StreamingAccountSessionVault(createStore()));
    const adapter: StreamingAccountAdapter = {
      provider: "anixart",
      async connect() { return { sessionPayload: "secret-token", accountLabel: "test-user" }; },
      async validateSession() { return true; },
    };
    expect(manager.hasAdapter("anixart")).toBe(false);
    manager.register(adapter);
    expect(manager.hasAdapter("anixart")).toBe(true);
    expect(manager.hasAdapter("animego")).toBe(false);

    const status = await manager.connect("anixart", { login: "test", password: "never-persist" });

    expect(status).toMatchObject({ state: "connected", connected: true, accountLabel: "test-user" });
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect(JSON.stringify(status)).not.toContain("password");
  });

  it("supports two-step native WebView authentication without exposing cookies", async () => {
    const store = createStore();
    const manager = new StreamingAccountManager(new StreamingAccountSessionVault(store));
    let opened = false;
    const adapter: StreamingAccountAdapter = {
      provider: "animego",
      async connect() { throw new Error("password login must not be used"); },
      async beginConnect() { opened = true; },
      async completeConnect() {
        if (!opened) throw new Error("auth window not opened");
        return { sessionPayload: "native-webview-session:v1", accountLabel: "demo-user" };
      },
      async validateSession() { return opened; },
      async getSessionInfo() { return { accountLabel: "demo-user" }; },
      async disconnect() { opened = false; },
    };
    manager.register(adapter);

    await manager.beginConnect("animego");
    expect(manager.getStatus("animego").state).toBe("connecting");
    const status = await manager.completeConnect("animego");

    expect(status).toMatchObject({ connected: true, state: "connected", accountLabel: "demo-user" });
    expect(JSON.stringify(status)).not.toContain("native-webview-session");
    expect([...store.values.values()]).toContain("native-webview-session:v1");

    const restored = await manager.restore("animego");
    expect(restored).toMatchObject({ connected: true, accountLabel: "demo-user" });
  });

  it("clears expired sessions during restore", async () => {
    const store = createStore();
    const vault = new StreamingAccountSessionVault(store);
    await vault.save("animego", "expired-cookie");
    const manager = new StreamingAccountManager(vault);
    manager.register({
      provider: "animego",
      async connect() { return { sessionPayload: "new-cookie" }; },
      async validateSession() { return false; },
    });

    const status = await manager.restore("animego");

    expect(status.state).toBe("expired");
    expect(await vault.read("animego")).toBeNull();
  });

  it("clears secrets even when provider disconnect cleanup fails", async () => {
    const vault = new StreamingAccountSessionVault(createStore());
    await vault.save("animego", "session");
    const manager = new StreamingAccountManager(vault);
    manager.register({
      provider: "animego",
      async connect() { return { sessionPayload: "session" }; },
      async validateSession() { return true; },
      async disconnect() { throw new Error("provider unavailable"); },
    });

    await expect(manager.disconnect("animego")).rejects.toThrow("provider unavailable");
    expect(await vault.read("animego")).toBeNull();
    expect(manager.getStatus("animego").state).toBe("disconnected");
  });
  it("inspects AnimeGO write forms only through a connected adapter", async () => {
    const manager = new StreamingAccountManager(new StreamingAccountSessionVault(createStore()));
    const expected = {
      provider: "animego" as const,
      titleUrl: "https://animego.me/anime/example-123",
      httpStatus: 200,
      forms: [{
        method: "POST",
        actionPath: "/mylist/anime/123/1/add",
        enctype: "application/x-www-form-urlencoded",
        purpose: "list",
        fieldNames: ["token"],
        fields: [{ name: "token", tag: "input", inputType: "hidden", required: false }],
        hasCsrfField: true,
        hasInlineEventHandler: false,
        hasDataAction: false,
      }],
      csrfMetaNames: ["csrf-token"],
      interactiveControls: [],
      sameOriginScriptPaths: [],
      inlineScriptHints: [],
      scriptsInspected: 2,
      scriptsSkipped: 1,
      scriptRouteCandidates: [{ path: "/mylist/anime/", methods: ["POST"], capabilities: ["list-membership"], fieldHints: ["token"], signals: ["fetch"] }],
      accountLists: [],
      note: "read-only",
    };
    let inspectedUrl = "";
    manager.register({
      provider: "animego",
      async connect() { return { sessionPayload: "native-session" }; },
      async validateSession() { return true; },
      async inspectWriteCapabilities(url) { inspectedUrl = url; return expected; },
    });
    await manager.connect("animego", {});
    const result = await manager.inspectWriteCapabilities("animego", expected.titleUrl);
    expect(result).toEqual(expected);
    expect(inspectedUrl).toBe(expected.titleUrl);
  });

  it("writes an AnimeGO rating only through a connected adapter and returns verification state", async () => {
    const manager = new StreamingAccountManager(new StreamingAccountSessionVault(createStore()));
    const expected = {
      provider: "animego" as const,
      titleUrl: "https://animego.me/anime/example-123",
      rating: 9,
      httpStatus: 200,
      submitted: true,
      verified: true,
      verifiedRating: 9,
      durationMs: 42,
    };
    let written = 0;
    manager.register({
      provider: "animego",
      async connect() { return { sessionPayload: "native-session" }; },
      async validateSession() { return true; },
      async setRating(titleUrl, rating) {
        expect(titleUrl).toBe(expected.titleUrl);
        expect(rating).toBe(9);
        written += 1;
        return expected;
      },
    });
    await manager.connect("animego", {});
    await expect(manager.setRating("animego", expected.titleUrl, 9)).resolves.toEqual(expected);
    expect(written).toBe(1);
    await expect(manager.setRating("animego", expected.titleUrl, 11)).rejects.toThrow("от 1 до 10");
    expect(written).toBe(1);
  });

  it("fetches a read-only provider list only through the registered native adapter", async () => {
    const manager = new StreamingAccountManager(new StreamingAccountSessionVault(createStore()));
    const expected = {
      provider: "animego",
      account: { userId: "123456", accountLabel: "demo-user" },
      fetchedAt: "unix:123",
      lists: [{ listType: 1, pageCount: 1, itemCount: 1 }],
      total: 1,
      items: [{ provider: "animego", listEntryId: "77", animeId: "4033", listType: 1 }],
    };
    let fetchCount = 0;
    manager.register({
      provider: "animego",
      async connect() { return { sessionPayload: "opaque-session" }; },
      async validateSession() { return true; },
      async fetchList() { fetchCount += 1; return expected; },
    });

    await manager.connect("animego", {});
    const result = await manager.fetchList("animego");

    expect(result).toEqual(expected);
    expect(fetchCount).toBe(1);
  });

});
