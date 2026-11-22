import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamingRuntimeFromHost,
  type StreamingRuntimeHost,
} from "../src/services/platform/runtime-bootstrap.js";

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

  it("composes Android only when native secure storage and HTTP are injected", () => {
    const secureStorage = {
      get: vi.fn(async () => ({ value: null })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const http = { request: vi.fn(async () => ({ status: 200, data: {}, headers: {} })) };

    const runtime = createStreamingRuntimeFromHost({
      __MIDO_STREAMING_ANDROID__: { secureStorage, http },
    });

    expect(runtime?.platform).toBe("capacitor-android");
  });

  it("does not create a browser runtime or fall back to web storage", () => {
    expect(createStreamingRuntimeFromHost({})).toBeNull();
    expect(createStreamingRuntimeFromHost(null)).toBeNull();
  });

  it("prefers the Tauri bridge if both host markers are present", () => {
    const invoke = vi.fn(async <T,>() => null as T);
    const runtime = createStreamingRuntimeFromHost({
      __TAURI__: { core: { invoke } },
      __MIDO_STREAMING_ANDROID__: {
        secureStorage: {
          get: vi.fn(async () => ({ value: null })),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
        http: { request: vi.fn(async () => ({ status: 200, data: {}, headers: {} })) },
      },
    });

    expect(runtime?.platform).toBe("windows-native");
  });
});
