import { describe, expect, it, vi } from "vitest";
import {
  createDisconnectedStreamingAccountInfo,
  StreamingAccountSessionVault,
  type StreamingSecureSecretStore,
} from "../src/services/streaming-account-session.js";

function createFakeSecureStore(): StreamingSecureSecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}

describe("streaming account session vault", () => {
  it("stores provider sessions through the injected secure-store adapter", async () => {
    const secureStore = createFakeSecureStore();
    const vault = new StreamingAccountSessionVault(secureStore);

    await vault.save("anixart", "opaque-session-payload");

    expect(await vault.read("anixart")).toBe("opaque-session-payload");
    expect(await vault.has("anixart")).toBe(true);
    expect([...secureStore.values.keys()]).toEqual([
      "mido-anime-sync:streaming-session:v1:anixart",
    ]);
  });

  it("isolates sessions by provider", async () => {
    const secureStore = createFakeSecureStore();
    const vault = new StreamingAccountSessionVault(secureStore);

    await vault.save("anixart", "anixart-session");
    await vault.save("animego", "animego-session");

    expect(await vault.read("anixart")).toBe("anixart-session");
    expect(await vault.read("animego")).toBe("animego-session");
  });

  it("removes only the selected provider session", async () => {
    const secureStore = createFakeSecureStore();
    const vault = new StreamingAccountSessionVault(secureStore);
    await vault.save("anixart", "anixart-session");
    await vault.save("animego", "animego-session");

    await vault.clear("anixart");

    expect(await vault.read("anixart")).toBeNull();
    expect(await vault.read("animego")).toBe("animego-session");
  });

  it("rejects empty session payloads without writing to storage", async () => {
    const secureStore = createFakeSecureStore();
    const set = vi.spyOn(secureStore, "set");
    const vault = new StreamingAccountSessionVault(secureStore);

    await expect(vault.save("animego", "  ")).rejects.toThrow("empty streaming account session");
    expect(set).not.toHaveBeenCalled();
  });

  it("exposes disconnected metadata without secret fields", () => {
    expect(createDisconnectedStreamingAccountInfo("animego")).toEqual({
      provider: "animego",
      connected: false,
      connectedAt: null,
      expiresAt: null,
      accountLabel: null,
    });
  });
});
