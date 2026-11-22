import type { StreamingProviderId } from "./streaming-provider.js";

/**
 * Platform adapter contract for OS-backed secret storage.
 *
 * Implementations must use Android Keystore-backed storage or the Windows
 * Credential Manager / OS keyring. Do not implement this with localStorage,
 * IndexedDB, the synced library database, or a plaintext file.
 */
export interface StreamingSecureSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Non-secret account information that is safe to expose to UI state. */
export interface StreamingAccountSessionInfo {
  provider: StreamingProviderId;
  connected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  /** Optional public account label or username, never an email/password/token. */
  accountLabel: string | null;
}

/**
 * Minimal vault for provider session material.
 *
 * The vault deliberately has no default storage implementation. The app must
 * inject a native secure-store adapter for the current platform. This prevents
 * accidentally falling back to browser storage in web builds.
 *
 * Provider session payloads are opaque to this layer. Provider adapters own
 * their format and must never put passwords into a persisted session payload.
 */
export class StreamingAccountSessionVault {
  private readonly prefix = "mido-anime-sync:streaming-session:v1:";

  constructor(private readonly secureStore: StreamingSecureSecretStore) {}

  async save(provider: StreamingProviderId, sessionPayload: string): Promise<void> {
    if (!sessionPayload.trim()) {
      throw new Error("Cannot save an empty streaming account session.");
    }
    await this.secureStore.set(this.key(provider), sessionPayload);
  }

  async read(provider: StreamingProviderId): Promise<string | null> {
    return this.secureStore.get(this.key(provider));
  }

  async has(provider: StreamingProviderId): Promise<boolean> {
    return (await this.read(provider)) !== null;
  }

  async clear(provider: StreamingProviderId): Promise<void> {
    await this.secureStore.remove(this.key(provider));
  }

  private key(provider: StreamingProviderId): string {
    return `${this.prefix}${provider}`;
  }
}

/**
 * Session metadata is intentionally kept separate from the secret vault.
 * It may be held in ephemeral UI state or a non-secret preferences store, but
 * must never contain cookies, bearer tokens, passwords, or CSRF values.
 */
export function createDisconnectedStreamingAccountInfo(
  provider: StreamingProviderId,
): StreamingAccountSessionInfo {
  return {
    provider,
    connected: false,
    connectedAt: null,
    expiresAt: null,
    accountLabel: null,
  };
}
