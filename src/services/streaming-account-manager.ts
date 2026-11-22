import type { StreamingProviderId } from "./streaming-provider.js";
import {
  StreamingAccountSessionVault,
  type StreamingAccountSessionInfo,
} from "./streaming-account-session.js";

export type StreamingAccountState =
  | "disconnected" | "connecting" | "connected" | "expired" | "unsupported" | "error";

export interface StreamingAccountStatus extends StreamingAccountSessionInfo {
  state: StreamingAccountState;
  errorMessage: string | null;
}

export interface StreamingAccountConnectResult {
  /** Opaque session payload. Never expose this value to UI or library storage. */
  sessionPayload: string;
  accountLabel?: string | null;
  expiresAt?: string | null;
}

export interface StreamingAccountAdapter {
  readonly provider: StreamingProviderId;
  connect(input: unknown): Promise<StreamingAccountConnectResult>;
  validateSession(sessionPayload: string): Promise<boolean>;
  disconnect?(sessionPayload: string | null): Promise<void>;
}

/**
 * Coordinates account lifecycle and the secure vault. UI receives status only,
 * never session material. Provider adapters own authentication details.
 */
export class StreamingAccountManager {
  private readonly adapters = new Map<StreamingProviderId, StreamingAccountAdapter>();
  private readonly states = new Map<StreamingProviderId, StreamingAccountStatus>();

  constructor(private readonly vault: StreamingAccountSessionVault) {}

  register(adapter: StreamingAccountAdapter): void {
    if (this.adapters.has(adapter.provider)) throw new Error(`Account adapter already registered: ${adapter.provider}`);
    this.adapters.set(adapter.provider, adapter);
  }

  getStatus(provider: StreamingProviderId): StreamingAccountStatus {
    return { ...(this.states.get(provider) ?? disconnectedStatus(provider)) };
  }

  async connect(provider: StreamingProviderId, input: unknown): Promise<StreamingAccountStatus> {
    const adapter = this.requireAdapter(provider);
    this.states.set(provider, { ...disconnectedStatus(provider), state: "connecting" });
    try {
      const result = await adapter.connect(input);
      if (!result.sessionPayload.trim()) throw new Error("Provider returned an empty session.");
      await this.vault.save(provider, result.sessionPayload);
      const status: StreamingAccountStatus = {
        provider, connected: true, connectedAt: new Date().toISOString(),
        expiresAt: result.expiresAt ?? null, accountLabel: result.accountLabel ?? null,
        state: "connected", errorMessage: null,
      };
      this.states.set(provider, status);
      return { ...status };
    } catch (error) {
      const status = { ...disconnectedStatus(provider), state: "error" as const, errorMessage: safeError(error) };
      this.states.set(provider, status);
      throw error;
    }
  }

  async restore(provider: StreamingProviderId): Promise<StreamingAccountStatus> {
    const adapter = this.requireAdapter(provider);
    const session = await this.vault.read(provider);
    if (!session) {
      const status = disconnectedStatus(provider);
      this.states.set(provider, status);
      return { ...status };
    }
    try {
      const valid = await adapter.validateSession(session);
      if (!valid) {
        await this.vault.clear(provider);
        const status = { ...disconnectedStatus(provider), state: "expired" as const };
        this.states.set(provider, status);
        return { ...status };
      }
      const status: StreamingAccountStatus = {
        provider, connected: true, connectedAt: null, expiresAt: null,
        accountLabel: null, state: "connected", errorMessage: null,
      };
      this.states.set(provider, status);
      return { ...status };
    } catch (error) {
      const status = { ...disconnectedStatus(provider), state: "error" as const, errorMessage: safeError(error) };
      this.states.set(provider, status);
      return { ...status };
    }
  }

  async disconnect(provider: StreamingProviderId): Promise<void> {
    const adapter = this.adapters.get(provider);
    const session = await this.vault.read(provider);
    try {
      await adapter?.disconnect?.(session);
    } finally {
      await this.vault.clear(provider);
      this.states.set(provider, disconnectedStatus(provider));
    }
  }

  private requireAdapter(provider: StreamingProviderId): StreamingAccountAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No account adapter registered for ${provider}.`);
    return adapter;
  }
}

function disconnectedStatus(provider: StreamingProviderId): StreamingAccountStatus {
  return {
    provider, connected: false, connectedAt: null, expiresAt: null,
    accountLabel: null, state: "disconnected", errorMessage: null,
  };
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "Account operation failed.";
  return error.message.replace(/(token|cookie|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
