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

/** Shared UI-facing account lifecycle contract implemented by native and web runtimes. */
export interface AnimeGoWriteFieldInspection {
  name: string;
  tag: string;
  inputType: string;
  required: boolean;
}

export interface AnimeGoWriteFormInspection {
  method: string;
  actionPath: string;
  enctype: string;
  purpose: string;
  fieldNames: string[];
  fields: AnimeGoWriteFieldInspection[];
  hasCsrfField: boolean;
  hasInlineEventHandler: boolean;
  hasDataAction: boolean;
}

export interface AnimeGoInteractiveControlInspection {
  tag: string;
  name: string | null;
  inputType: string | null;
  id: string | null;
  classNames: string[];
  required: boolean;
  hasInlineEventHandler: boolean;
  hasDataAction: boolean;
}

export interface AnimeGoScriptRouteCandidateInspection {
  path: string;
  methods: string[];
  capabilities: string[];
  fieldHints: string[];
  signals: string[];
}

export interface AnimeGoNetworkEventInspection {
  method: string;
  path: string;
  transport: "fetch" | "xhr" | "form" | "beacon";
  fieldNames: string[];
  status: number | null;
}

export interface AnimeGoNetworkInspection {
  provider: "animego";
  pagePath: string;
  durationSeconds: number;
  events: AnimeGoNetworkEventInspection[];
  note: string;
}

export interface AnimeGoWriteInspection {
  provider: "animego";
  titleUrl: string;
  httpStatus: number;
  forms: AnimeGoWriteFormInspection[];
  csrfMetaNames: string[];
  interactiveControls: AnimeGoInteractiveControlInspection[];
  sameOriginScriptPaths: string[];
  inlineScriptHints: string[];
  scriptsInspected: number;
  scriptsSkipped: number;
  scriptRouteCandidates: AnimeGoScriptRouteCandidateInspection[];
  note: string;
}

export interface StreamingAccountManagerPort {
  hasAdapter(provider: StreamingProviderId): boolean;
  getStatus(provider: StreamingProviderId): StreamingAccountStatus;
  connect(provider: StreamingProviderId, input: unknown): Promise<StreamingAccountStatus>;
  restore(provider: StreamingProviderId): Promise<StreamingAccountStatus>;
  disconnect(provider: StreamingProviderId): Promise<void>;
  /** Optional two-step sign-in flow for providers that authenticate in a native WebView. */
  beginConnect?(provider: StreamingProviderId): Promise<void>;
  completeConnect?(provider: StreamingProviderId): Promise<StreamingAccountStatus>;
  /** Optional read-only provider list fetch; secrets remain inside the trusted adapter. */
  openSessionWindow?(provider: StreamingProviderId): Promise<void>;
  inspectNetwork?(provider: StreamingProviderId): Promise<AnimeGoNetworkInspection>;
  fetchList?(provider: StreamingProviderId): Promise<unknown>;
  inspectWriteCapabilities?(provider: StreamingProviderId, titleUrl: string): Promise<AnimeGoWriteInspection>;
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
  beginConnect?(): Promise<void>;
  completeConnect?(): Promise<StreamingAccountConnectResult>;
  getSessionInfo?(): Promise<{ accountLabel?: string | null; expiresAt?: string | null }>;
  /** Read-only account-list import. The adapter must keep session material native. */
  openSessionWindow?(): Promise<void>;
  inspectNetwork?(): Promise<AnimeGoNetworkInspection>;
  fetchList?(): Promise<unknown>;
  inspectWriteCapabilities?(titleUrl: string): Promise<AnimeGoWriteInspection>;
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

  hasAdapter(provider: StreamingProviderId): boolean {
    return this.adapters.has(provider);
  }

  getStatus(provider: StreamingProviderId): StreamingAccountStatus {
    return { ...(this.states.get(provider) ?? disconnectedStatus(provider)) };
  }

  async beginConnect(provider: StreamingProviderId): Promise<void> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.beginConnect) throw new Error(`Interactive WebView sign-in is unavailable for ${provider}.`);
    this.states.set(provider, { ...disconnectedStatus(provider), state: "connecting" });
    try {
      await adapter.beginConnect();
    } catch (error) {
      const status = { ...disconnectedStatus(provider), state: "error" as const, errorMessage: safeError(error) };
      this.states.set(provider, status);
      throw error;
    }
  }

  async completeConnect(provider: StreamingProviderId): Promise<StreamingAccountStatus> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.completeConnect) throw new Error(`Interactive WebView sign-in is unavailable for ${provider}.`);
    this.states.set(provider, { ...disconnectedStatus(provider), state: "connecting" });
    try {
      const result = await adapter.completeConnect();
      if (!result.sessionPayload.trim()) throw new Error("Provider returned an empty session marker.");
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
      const info = await adapter.getSessionInfo?.();
      const status: StreamingAccountStatus = {
        provider, connected: true, connectedAt: null, expiresAt: info?.expiresAt ?? null,
        accountLabel: info?.accountLabel ?? null, state: "connected", errorMessage: null,
      };
      this.states.set(provider, status);
      return { ...status };
    } catch (error) {
      const status = { ...disconnectedStatus(provider), state: "error" as const, errorMessage: safeError(error) };
      this.states.set(provider, status);
      return { ...status };
    }
  }

  async inspectWriteCapabilities(provider: StreamingProviderId, titleUrl: string): Promise<AnimeGoWriteInspection> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.inspectWriteCapabilities) throw new Error(`Write inspection is unavailable for ${provider}.`);
    const status = await this.restore(provider);
    if (!status.connected) throw new Error(`Сначала подключи аккаунт ${provider}.`);
    return adapter.inspectWriteCapabilities(titleUrl);
  }

  async openSessionWindow(provider: StreamingProviderId): Promise<void> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.openSessionWindow) throw new Error(`Opening the provider session window is unavailable for ${provider}.`);
    await adapter.openSessionWindow();
  }

  async inspectNetwork(provider: StreamingProviderId): Promise<AnimeGoNetworkInspection> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.inspectNetwork) throw new Error(`Network inspection is unavailable for ${provider}.`);
    const status = await this.restore(provider);
    if (!status.connected) throw new Error(`Сначала подключи аккаунт ${provider}.`);
    return adapter.inspectNetwork();
  }

  async fetchList(provider: StreamingProviderId): Promise<unknown> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.fetchList) throw new Error(`Account-list import is unavailable for ${provider}.`);
    const status = await this.restore(provider);
    if (!status.connected) throw new Error(`Сначала подключи аккаунт ${provider}.`);
    return adapter.fetchList();
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
  if (error instanceof Error && error.name === "AbortError") return "Account operation cancelled.";
  return "Account operation failed. Sensitive provider details were omitted.";
}
