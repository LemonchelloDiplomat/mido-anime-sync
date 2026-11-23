import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeInvoke } from "../src/services/platform/native-platform-adapters.js";
import {
  createStreamingRuntimeFromHost,
  initializeStreamingRuntimeFromHost,
  type CapacitorAndroidModules,
  type StreamingRuntimeHost,
} from "../src/services/platform/runtime-bootstrap.js";

function createAndroidModules(): CapacitorAndroidModules {
  return {
    secureStorage: {
      get: vi.fn(async () => ({ value: null })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    http: {
      request: vi.fn(async () => ({ status: 200, data: {}, headers: {} })),
    },
  };
}

describe("native streaming runtime bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("composes the Windows runtime when the trusted Tauri bridge exists", () => {
    const invoke: NativeInvoke = async <T,>() => null as T;
    const host: StreamingRuntimeHost = { __TAURI__: { core: { invoke } } };

    const runtime = createStreamingRuntimeFromHost(host);

    expect(runtime?.platform).toBe("windows-native");
    expect(runtime?.accounts.getStatus("animego").state).toBe("disconnected");
    expect(runtime?.accounts.getStatus("anixart").state).toBe("disconnected");
  });

  it("composes Android from the explicitly injected native dependencies", () => {
    const runtime = createStreamingRuntimeFromHost({
      __MIDO_STREAMING_ANDROID__: createAndroidModules(),
    });

    expect(runtime?.platform).toBe("capacitor-android");
  });

  it("loads the installed Capacitor plugins on a native Android host", async () => {
    const modules = createAndroidModules();
    const loader = vi.fn(async () => modules);
    const runtime = await initializeStreamingRuntimeFromHost({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "android",
      },
    }, loader);

    expect(loader).toHaveBeenCalledOnce();
    expect(runtime?.platform).toBe("capacitor-android");
  });

  it("does not load native packages in a browser", async () => {
    const loader = vi.fn(async () => createAndroidModules());

    expect(await initializeStreamingRuntimeFromHost({}, loader)).toBeNull();
    expect(await initializeStreamingRuntimeFromHost(null, loader)).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });


  it("composes the browser runtime when the local API is available", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/health") {
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
    vi.stubGlobal("fetch", fetcher);
    const loader = vi.fn(async () => createAndroidModules());

    const runtime = await initializeStreamingRuntimeFromHost({}, loader);

    expect(runtime?.platform).toBe("web-local");
    expect(runtime?.http).toBeNull();
    expect(runtime?.accounts.getStatus("animego").state).toBe("unsupported");
    expect(runtime?.accounts.hasAdapter("animego")).toBe(false);
    expect(loader).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps browser-only mode when the local API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const runtime = await initializeStreamingRuntimeFromHost({});

    expect(runtime).toBeNull();
  });

  it("does not load Android packages for a non-Android Capacitor host", async () => {
    const loader = vi.fn(async () => createAndroidModules());
    const runtime = await initializeStreamingRuntimeFromHost({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
      },
    }, loader);

    expect(runtime).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("prefers the Tauri bridge if both native host markers are present", async () => {
    const invoke: NativeInvoke = async <T,>() => null as T;
    const loader = vi.fn(async () => createAndroidModules());
    const runtime = await initializeStreamingRuntimeFromHost({
      __TAURI__: { core: { invoke } },
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "android",
      },
    }, loader);

    expect(runtime?.platform).toBe("windows-native");
    expect(loader).not.toHaveBeenCalled();
  });
});
