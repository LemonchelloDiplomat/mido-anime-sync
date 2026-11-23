import { describe, expect, it } from "vitest";
import {
  StreamingAccountManager,
  type StreamingAccountAdapter,
} from "../src/services/streaming-account-manager.js";
import {
  StreamingAccountSessionVault,
  type StreamingSecureSecretStore,
} from "../src/services/streaming-account-session.js";

function createStore(): StreamingSecureSecretStore {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
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
});
