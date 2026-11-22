import {
  createAndroidStreamingRuntime,
  createWindowsStreamingRuntime,
  type AndroidStreamingRuntimeDependencies,
  type StreamingRuntime,
} from "./streaming-runtime.js";
import type { NativeInvoke } from "./native-platform-adapters.js";

/**
 * Native Android entrypoints may inject already-registered Capacitor plugins.
 * This is intentionally an explicit bridge, not a browser storage fallback.
 */
export interface StreamingRuntimeHost {
  __TAURI__?: {
    core?: {
      invoke?: NativeInvoke;
    };
  };
  __MIDO_STREAMING_ANDROID__?: AndroidStreamingRuntimeDependencies;
}

/**
 * Detect the native host during application startup.
 *
 * Windows Tauri is composed automatically. Android requires the native
 * Capacitor entrypoint to inject SecureStorage and CapacitorHttp; until then
 * this returns null rather than silently using web storage or fetch.
 */
export function createStreamingRuntimeFromHost(
  host: StreamingRuntimeHost | null = getHostWindow(),
): StreamingRuntime | null {
  if (!host) return null;

  const invoke = host.__TAURI__?.core?.invoke;
  if (invoke) return createWindowsStreamingRuntime(invoke);

  const android = host.__MIDO_STREAMING_ANDROID__;
  if (android) return createAndroidStreamingRuntime(android);

  return null;
}

function getHostWindow(): StreamingRuntimeHost | null {
  if (typeof window === "undefined") return null;
  return window as Window & StreamingRuntimeHost;
}
