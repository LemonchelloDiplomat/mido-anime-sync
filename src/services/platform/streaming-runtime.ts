import {
  StreamingAccountManager,
  type StreamingAccountAdapter,
} from "../streaming-account-manager.js";
import { StreamingAccountSessionVault } from "../streaming-account-session.js";
import {
  StreamingHttpClient,
  type StreamingHttpTransport,
} from "../streaming-http-client.js";
import { StreamingRequestQueue } from "../streaming-request-queue.js";
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
  readonly platform: "windows-native" | "capacitor-android";
  readonly accounts: StreamingAccountManager;
  readonly http: StreamingHttpClient;
  readonly requests: StreamingRequestQueue;
  /** Register a verified provider adapter after runtime construction. */
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
  return createStreamingRuntime(
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
  return createStreamingRuntime(
    "capacitor-android",
    new CapacitorAndroidSecureSecretStore(dependencies.secureStorage),
    new CapacitorAndroidStreamingHttpTransport(dependencies.http),
    accountAdapters,
  );
}

function createStreamingRuntime(
  platform: StreamingRuntime["platform"],
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
