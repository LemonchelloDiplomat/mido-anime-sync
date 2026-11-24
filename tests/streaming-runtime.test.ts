import { describe, expect, it, vi } from "vitest";
import {
  createAndroidStreamingRuntime,
  createWebStreamingRuntime,
  createWindowsStreamingRuntime,
} from "../src/services/platform/streaming-runtime.js";
import type { StreamingAccountAdapter } from "../src/services/streaming-account-manager.js";
import type { NativeInvoke } from "../src/services/platform/native-platform-adapters.js";

function accountAdapter(provider: "animego" | "anixart"): StreamingAccountAdapter {
  return {
    provider,
    async connect() { return { sessionPayload: `opaque-${provider}`, accountLabel: "demo" }; },
    async validateSession() { return true; },
  };
}

describe("platform streaming runtime composition", () => {
  it("composes Windows secure storage, account manager, HTTP client and queue", async () => {
    const secrets = new Map<string, string>();
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "streaming_secret_get") return secrets.get(String(args?.key)) ?? null;
      if (command === "streaming_secret_set") {
        secrets.set(String(args?.key), String(args?.value));
        return undefined;
      }
      if (command === "streaming_secret_remove") {
        secrets.delete(String(args?.key));
        return undefined;
      }
      if (command === "streaming_http_request") {
        return { status: 200, headers: {}, data: { ok: true }, url: String((args?.request as { url: string }).url) };
      }
      if (command === "animego_auth_open" || command === "animego_auth_disconnect") return undefined;
      if (command === "animego_auth_complete" || command === "animego_auth_status") {
        return { connected: true, accountLabel: "animego-user", state: "connected" };
      }
      throw new Error(`Unexpected command: ${command}`);
    }) as NativeInvoke;
    const runtime = createWindowsStreamingRuntime(invoke, [accountAdapter("anixart")]);

    expect(runtime.platform).toBe("windows-native");
    expect(runtime.accounts.hasAdapter("animego")).toBe(true);
    const status = await runtime.accounts.connect("anixart", {});
    expect(status).toMatchObject({ connected: true, state: "connected", accountLabel: "demo" });
    expect(JSON.stringify(status)).not.toContain("opaque-anixart");

    const response = await runtime.http.request<{ ok: boolean }>({
      provider: "anixart", url: "https://anixart.site/api/profile",
    });
    expect(response.data).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("streaming_http_request", expect.objectContaining({
      request: expect.objectContaining({ provider: "anixart", url: "https://anixart.site/api/profile" }),
    }));
    expect(runtime.requests).toBeDefined();
  });

  it("uses the native AnimeGO WebView2 window and never sends credentials from the renderer", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "animego_auth_open" || command === "animego_auth_disconnect") return undefined;
      if (command === "animego_auth_complete" || command === "animego_auth_status") {
        return { connected: true, accountLabel: "animego-user", state: "connected" };
      }
      if (command === "animego_account_list_fetch") {
        return {
          provider: "animego",
          account: { userId: "123456", accountLabel: "animego-user" },
          fetchedAt: "unix:123",
          lists: [{ listType: 1, pageCount: 1, itemCount: 1 }],
          total: 1,
          items: [{ provider: "animego", listEntryId: "77", animeId: "4033", listType: 1 }],
        };
      }
      if (command === "streaming_secret_set" || command === "streaming_secret_remove") return undefined;
      if (command === "streaming_secret_get") return "windows-webview-session:v1";
      throw new Error("Unexpected command: " + command);
    }) as NativeInvoke;
    const runtime = createWindowsStreamingRuntime(invoke);

    expect(runtime.accounts.hasAdapter("animego")).toBe(true);
    await runtime.accounts.beginConnect!("animego");
    expect(invoke).toHaveBeenCalledWith("animego_auth_open");

    const status = await runtime.accounts.completeConnect!("animego");
    expect(status).toMatchObject({ connected: true, accountLabel: "animego-user" });
    expect(invoke).toHaveBeenCalledWith("animego_auth_complete");
    expect(JSON.stringify(status)).not.toContain("cookie");

    const accountList = await runtime.accounts.fetchList!("animego") as { total: number; items: unknown[] };
    expect(accountList.total).toBe(1);
    expect(accountList.items).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("animego_account_list_fetch");
  });

  it("composes Android Keystore and Capacitor native HTTP without web storage", async () => {
    const secrets = new Map<string, string>();
    const secureStorage = {
      async get({ key }: { key: string }) { return { value: secrets.get(key) ?? null }; },
      async set({ key, value }: { key: string; value: string }) { secrets.set(key, value); },
      async remove({ key }: { key: string }) { secrets.delete(key); },
    };
    const http = {
      request: vi.fn(async ({ url }: { url: string }) => ({
        status: 200, headers: { "Content-Type": "application/json" }, data: { url }, url,
      })),
    };
    const runtime = createAndroidStreamingRuntime({ secureStorage, http }, [accountAdapter("animego")]);

    expect(runtime.platform).toBe("capacitor-android");
    const status = await runtime.accounts.connect("animego", {});
    expect(status.connected).toBe(true);
    expect([...secrets.values()]).toContain("opaque-animego");

    const response = await runtime.http.request<{ url: string }>({
      provider: "animego", url: "https://animego.me/profile",
    });
    expect(response.data.url).toBe("https://animego.me/profile");
    expect(http.request).toHaveBeenCalledOnce();
    expect(runtime.requests).toBeDefined();
  });

  it("allows verified account adapters to be registered after initialization", async () => {
    const invoke = vi.fn(async () => null) as NativeInvoke;
    const runtime = createWindowsStreamingRuntime(invoke);
    runtime.registerAccountAdapter(accountAdapter("anixart"));

    const status = await runtime.accounts.connect("anixart", {});
    expect(status.state).toBe("connected");
  });

  it("keeps provider host isolation when using the composed HTTP client", async () => {
    const http = { request: vi.fn() };
    const secureStorage = {
      async get() { return { value: null }; },
      async set() {},
      async remove() {},
    };
    const runtime = createAndroidStreamingRuntime({ secureStorage, http });

    await expect(runtime.http.request({
      provider: "animego", url: "https://anixart.site/profile",
    })).rejects.toThrow("provider allowlist");
    expect(http.request).not.toHaveBeenCalled();
  });

  it("retries local API health checks while the server is starting", async () => {
    let healthAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/health") {
        healthAttempts += 1;
        if (healthAttempts === 1) return new Response("starting", { status: 503 });
        return new Response(JSON.stringify({ ok: true, mode: "local", apiVersion: 1 }), { status: 200 });
      }
      const provider = path.includes("/animego/") ? "animego" : "anixart";
      return new Response(JSON.stringify({
        provider,
        adapterAvailable: false,
        status: {
          provider,
          connected: false,
          connectedAt: null,
          expiresAt: null,
          accountLabel: null,
          state: "unsupported",
          errorMessage: null,
        },
      }), { status: 200 });
    });

    const runtime = await createWebStreamingRuntime(fetcher, { attempts: 3, delayMs: 0 });

    expect(runtime?.platform).toBe("web-local");
    expect(healthAttempts).toBe(2);
  });
});
