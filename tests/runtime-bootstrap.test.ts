import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.restoreAllMocks());

  it("composes the Windows runtime when the trusted Tauri bridge exists", () => {
    const invoke = vi.fn(async <T,>() => null as T);
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
    const invoke = vi.fn(async <T,>() => null as T);
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
