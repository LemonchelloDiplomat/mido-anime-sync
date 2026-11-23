import {
  StreamingAccountManager,
  type StreamingAccountAdapter,
  type StreamingAccountManagerPort,
} from "../streaming-account-manager.js";
import { StreamingAccountSessionVault } from "../streaming-account-session.js";
import {
  StreamingHttpClient,
  type StreamingHttpTransport,
} from "../streaming-http-client.js";
import { StreamingRequestQueue } from "../streaming-request-queue.js";
import { WebApiStreamingAccountManager } from "./web-streaming-account-manager.js";
import {
  CapacitorAndroidSecureSecretStore,
  CapacitorAndroidStreamingHttpTransport,
  TauriWindowsSecureSecretStore,
  TauriWindowsStreamingHttpTransport,
  type CapacitorHttpPlugin,
  type CapacitorSecureStoragePlugin,
  type NativeInvoke,
} from "./native-platform-adapters.js";

export interface StreamingRuntime {
  readonly platform: "windows-native" | "capacitor-android" | "web-local";
  readonly accounts: StreamingAccountManagerPort;
  /** Web provider requests are executed by server-side adapters, never renderer fetch. */
  readonly http: StreamingHttpClient;
  readonly requests: StreamingRequestQueue;
  /** Native runtimes register trusted in-process adapters; web adapters live on the server. */
  registerAccountAdapter(adapter: StreamingAccountAdapter): void;
}

/**
 * Compose all shared streaming services over the Windows native adapters.
 * The caller must supply Tauri's invoke bridge from the trusted app runtime.
 */
export function createWindowsStreamingRuntime(
  invoke: NativeInvoke,
  accountAdapters: readonly StreamingAccountAdapter[] = [],
): StreamingRuntime {
  return createNativeStreamingRuntime(
    "windows-native",
    new TauriWindowsSecureSecretStore(invoke),
    new TauriWindowsStreamingHttpTransport(invoke),
    accountAdapters,
  );
}

export interface AndroidStreamingRuntimeDependencies {
  secureStorage: CapacitorSecureStoragePlugin;
  http: CapacitorHttpPlugin;
}

/**
 * Compose all shared streaming services over Android Keystore and Capacitor
 * native HTTP. No browser/localStorage fallback is provided.
 */
export function createAndroidStreamingRuntime(
  dependencies: AndroidStreamingRuntimeDependencies,
  accountAdapters: readonly StreamingAccountAdapter[] = [],
): StreamingRuntime {
  return createNativeStreamingRuntime(
    "capacitor-android",
    new CapacitorAndroidSecureSecretStore(dependencies.secureStorage),
    new CapacitorAndroidStreamingHttpTransport(dependencies.http),
    accountAdapters,
  );
}

/**
 * Compose the browser runtime over the local Node API. Future provider
 * adapters will own sessions and provider HTTP on that trusted server;
 * browser storage and renderer-side provider requests are deliberately unused.
 */
export interface WebStreamingRuntimeRetryOptions {
  /** Number of health checks, including the first attempt. */
  attempts?: number;
  /** Delay between failed health checks. */
  delayMs?: number;
}

export async function createWebStreamingRuntime(
  fetcher: typeof fetch = fetch,
  retryOptions: WebStreamingRuntimeRetryOptions = {},
): Promise<StreamingRuntime | null> {
  const attempts = Math.max(1, Math.floor(retryOptions.attempts ?? 8));
  const delayMs = Math.max(0, retryOptions.delayMs ?? 250);
  let isHealthy = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const health = await fetcher("/api/health", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (health.ok) {
        const healthPayload: unknown = await health.json();
        isHealthy = Boolean(
          healthPayload &&
          typeof healthPayload === "object" &&
          (healthPayload as { mode?: unknown }).mode === "local",
        );
      }
    } catch {
      // The local API may still be starting or briefly restarting.
    }

    if (isHealthy) break;
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!isHealthy) return null;

  const accounts = new WebApiStreamingAccountManager(fetcher);
  await accounts.initialize();

  return {
    platform: "web-local",
    accounts,
    http: new StreamingHttpClient({
      platform: "web-local",
      async request<T>() {
        throw new Error("Web provider requests must be executed by a trusted server-side adapter.");
      },
    }),
    requests: new StreamingRequestQueue(),
    registerAccountAdapter() {
      throw new Error("Web provider adapters must be registered in the trusted local API server.");
    },
  };
}

function createNativeStreamingRuntime(
  platform: "windows-native" | "capacitor-android",
  secureStore: ConstructorParameters<typeof StreamingAccountSessionVault>[0],
  transport: StreamingHttpTransport,
  accountAdapters: readonly StreamingAccountAdapter[],
): StreamingRuntime {
  const vault = new StreamingAccountSessionVault(secureStore);
  const accounts = new StreamingAccountManager(vault);
  for (const adapter of accountAdapters) accounts.register(adapter);

  return {
    platform,
    accounts,
    http: new StreamingHttpClient(transport),
    requests: new StreamingRequestQueue(),
    registerAccountAdapter(adapter) {
      accounts.register(adapter);
    },
  };
}
