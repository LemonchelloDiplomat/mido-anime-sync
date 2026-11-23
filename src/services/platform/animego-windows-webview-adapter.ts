import type {
  StreamingAccountAdapter,
  StreamingAccountConnectResult,
} from "../streaming-account-manager.js";
import type { NativeInvoke } from "./native-platform-adapters.js";

interface NativeAnimeGoAuthStatus {
  connected: boolean;
  accountLabel: string | null;
  state: "connected" | "disconnected" | "expired";
}

/**
 * Windows sign-in happens in a dedicated Tauri WebView2 window.
 * The HttpOnly cookies never leave Rust: commands validate and persist them
 * directly through Windows Credential Manager. The shared vault stores only
 * a non-secret marker so the common account lifecycle can restore state.
 */
export class AnimeGoWindowsWebViewAdapter implements StreamingAccountAdapter {
  readonly provider = "animego" as const;
  private static readonly SESSION_MARKER = "windows-webview-session:v1";
  private lastStatus: NativeAnimeGoAuthStatus | null = null;

  constructor(private readonly invoke: NativeInvoke) {}

  async connect(): Promise<StreamingAccountConnectResult> {
    throw new Error("AnimeGO uses the embedded website sign-in flow. Open the sign-in window first.");
  }

  async beginConnect(): Promise<void> {
    await this.invoke<void>("animego_auth_open");
  }

  async completeConnect(): Promise<StreamingAccountConnectResult> {
    const status = await this.invoke<NativeAnimeGoAuthStatus>("animego_auth_complete");
    this.lastStatus = status;
    if (!status.connected) throw new Error("AnimeGO не подтвердил авторизацию.");
    return {
      sessionPayload: AnimeGoWindowsWebViewAdapter.SESSION_MARKER,
      accountLabel: status.accountLabel,
    };
  }

  async validateSession(sessionPayload: string): Promise<boolean> {
    if (sessionPayload !== AnimeGoWindowsWebViewAdapter.SESSION_MARKER) return false;
    const status = await this.invoke<NativeAnimeGoAuthStatus>("animego_auth_status");
    this.lastStatus = status;
    return status.connected;
  }

  async getSessionInfo(): Promise<{ accountLabel?: string | null }> {
    const status = this.lastStatus ?? await this.invoke<NativeAnimeGoAuthStatus>("animego_auth_status");
    this.lastStatus = status;
    return { accountLabel: status.accountLabel };
  }

  async disconnect(): Promise<void> {
    await this.invoke<void>("animego_auth_disconnect");
    this.lastStatus = { connected: false, accountLabel: null, state: "disconnected" };
  }
}
