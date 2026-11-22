import { describe, expect, it, vi } from "vitest";
import {
  CapacitorAndroidSecureSecretStore,
  CapacitorAndroidStreamingHttpTransport,
  TauriWindowsSecureSecretStore,
  TauriWindowsStreamingHttpTransport,
  type NativeInvoke,
} from "../src/services/platform/native-platform-adapters.js";

describe("native platform adapters", () => {
  it("maps Windows vault operations to native Credential Manager commands", async () => {
    const invoke = vi.fn(async (command: string) => command === "streaming_secret_get" ? "opaque-session" : undefined) as NativeInvoke;
    const store = new TauriWindowsSecureSecretStore(invoke);

    expect(await store.get("mido-anime-sync:streaming-session:v1:anixart")).toBe("opaque-session");
    await store.set("mido-anime-sync:streaming-session:v1:anixart", "new-session");
    await store.remove("mido-anime-sync:streaming-session:v1:anixart");

    expect(invoke).toHaveBeenNthCalledWith(1, "streaming_secret_get", {
      key: "mido-anime-sync:streaming-session:v1:anixart",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "streaming_secret_set", {
      key: "mido-anime-sync:streaming-session:v1:anixart", value: "new-session",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "streaming_secret_remove", {
      key: "mido-anime-sync:streaming-session:v1:anixart",
    });
  });

  it("uses the Capacitor secure storage plugin without a web fallback", async () => {
    const plugin = {
      get: vi.fn().mockResolvedValue({ value: "android-session" }),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const store = new CapacitorAndroidSecureSecretStore(plugin);

    expect(await store.get("animego")).toBe("android-session");
    await store.set("animego", "updated");
    await store.remove("animego");
    expect(plugin.get).toHaveBeenCalledWith({ key: "animego" });
    expect(plugin.set).toHaveBeenCalledWith({ key: "animego", value: "updated" });
    expect(plugin.remove).toHaveBeenCalledWith({ key: "animego" });
  });

  it("sends custom account headers through Capacitor native HTTP", async () => {
    const http = {
      request: vi.fn().mockResolvedValue({
        status: 200, headers: { "Content-Type": "text/html" }, data: "<main/>", url: "https://animego.me/me",
      }),
    };
    const transport = new CapacitorAndroidStreamingHttpTransport(http);

    const response = await transport.request<string>({
      provider: "animego", url: "https://animego.me/me", responseType: "text",
      headers: { Cookie: "session=secret", "User-Agent": "MidoAnimeSync", "X-CSRF-TOKEN": "csrf" },
    });

    expect(response.data).toBe("<main/>");
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      headers: { Cookie: "session=secret", "User-Agent": "MidoAnimeSync", "X-CSRF-TOKEN": "csrf" },
      responseType: "text",
    }));
  });

  it("rejects provider-host mismatches before either native transport is called", async () => {
    const invoke = vi.fn() as NativeInvoke;
    const windows = new TauriWindowsStreamingHttpTransport(invoke);
    const androidHttp = { request: vi.fn() };
    const android = new CapacitorAndroidStreamingHttpTransport(androidHttp);

    await expect(windows.request({
      provider: "animego", url: "https://anixart.site/account",
    })).rejects.toThrow("provider allowlist");
    await expect(android.request({
      provider: "anixart", url: "https://animego.me/account",
    })).rejects.toThrow("provider allowlist");

    expect(invoke).not.toHaveBeenCalled();
    expect(androidHttp.request).not.toHaveBeenCalled();
  });

  it("maps Windows native HTTP response and sends the request object", async () => {
    const invoke = vi.fn(async () => ({
      status: 200, headers: { "content-type": "application/json" }, data: { ok: true }, url: "https://anixart.site/api",
    })) as NativeInvoke;
    const transport = new TauriWindowsStreamingHttpTransport(invoke);

    const response = await transport.request<{ ok: boolean }>({
      provider: "anixart", url: "https://anixart.site/api", method: "POST",
      headers: { Cookie: "token=secret" }, body: "{\"status\":\"watching\"}",
    });

    expect(response.data).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("streaming_http_request", {
      request: expect.objectContaining({
        url: "https://anixart.site/api", method: "POST",
        headers: { Cookie: "token=secret" }, body: "{\"status\":\"watching\"}",
      }),
    });
  });
});
