import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  createAndroidStreamingRuntime,
  createWindowsStreamingRuntime,
  type AndroidStreamingRuntimeDependencies,
  type StreamingRuntime,
} from "./streaming-runtime.js";
import type {
  CapacitorHttpPlugin,
  CapacitorSecureStoragePlugin,
  NativeInvoke,
} from "./native-platform-adapters.js";

/** Capacitor's public runtime marker exposed by the native bridge. */
export interface CapacitorRuntimeBridge {
  isNativePlatform(): boolean;
  getPlatform(): string;
}

/**
 * Native Android entrypoints may inject already-registered Capacitor plugins.
 * This remains a supported test/embedding seam, not a browser storage fallback.
 */
export interface StreamingRuntimeHost {
  __TAURI__?: {
    core?: {
      invoke?: NativeInvoke;
    };
  };
  __MIDO_STREAMING_ANDROID__?: AndroidStreamingRuntimeDependencies;
  Capacitor?: CapacitorRuntimeBridge;
}

export interface CapacitorAndroidModules {
  secureStorage: CapacitorSecureStoragePlugin;
  http: CapacitorHttpPlugin;
}

export type CapacitorAndroidModuleLoader = () => Promise<CapacitorAndroidModules>;

/**
 * Synchronous composition for trusted native bridges that have already
 * supplied their dependencies. Browser runtimes deliberately return null.
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

/**
 * Initialize the runtime used by the app entrypoint.
 *
 * Tauri is composed synchronously. Capacitor Android loads the actual
 * installed plugin modules only after confirming a native Android host.
 * This keeps ordinary browser builds free of platform package dependencies
 * and never substitutes localStorage, IndexedDB, or browser fetch.
 */
export async function initializeStreamingRuntimeFromHost(
  host: StreamingRuntimeHost | null = getHostWindow(),
  loadAndroidModules: CapacitorAndroidModuleLoader = loadCapacitorAndroidModules,
): Promise<StreamingRuntime | null> {
  if (!host) return null;

  const invoke = host.__TAURI__?.core?.invoke;
  if (invoke) return createWindowsStreamingRuntime(invoke);

  if (host.__MIDO_STREAMING_ANDROID__) {
    return createAndroidStreamingRuntime(host.__MIDO_STREAMING_ANDROID__);
  }

  const capacitor = host.Capacitor ?? Capacitor;
  if (!capacitor?.isNativePlatform() || capacitor.getPlatform() !== "android") {
    return null;
  }

  const modules = await loadAndroidModules();
  return createAndroidStreamingRuntime(modules);
}

async function loadCapacitorAndroidModules(): Promise<CapacitorAndroidModules> {
  // Secure storage is a lazy native-only chunk. CapacitorHttp is part of core.
  const secureStorage = await import("@capnative/capacitor-secure-storage");

  if (!CapacitorHttp || !secureStorage.SecureStorage) {
    throw new Error("Capacitor Android streaming plugins are not registered. Run npm run setup:platforms and npx cap sync android.");
  }

  return {
    http: CapacitorHttp as CapacitorHttpPlugin,
    secureStorage: secureStorage.SecureStorage as CapacitorSecureStoragePlugin,
  };
}

function getHostWindow(): StreamingRuntimeHost | null {
  if (typeof window === "undefined") return null;
  return window as Window & StreamingRuntimeHost;
}
