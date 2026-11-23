import type { StreamingProviderId } from "../streaming-provider.js";
import type {
  StreamingAccountManagerPort,
  StreamingAccountStatus,
} from "../streaming-account-manager.js";

const PROVIDERS: readonly StreamingProviderId[] = ["animego", "anixart"];

interface WebAccountStatusResponse {
  provider: StreamingProviderId;
  adapterAvailable: boolean;
  status: StreamingAccountStatus;
}

/**
 * Browser facade for the local Node API. Provider secrets never cross this
 * boundary: the browser receives status metadata only. Authentication and
 * provider requests must be implemented by server-side adapters.
 */
export class WebApiStreamingAccountManager implements StreamingAccountManagerPort {
  private readonly adapterAvailability = new Map<StreamingProviderId, boolean>();
  private readonly statuses = new Map<StreamingProviderId, StreamingAccountStatus>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly basePath = "/api/streaming/accounts",
  ) {}

  async initialize(): Promise<void> {
    await Promise.all(PROVIDERS.map((provider) => this.restore(provider)));
  }

  hasAdapter(provider: StreamingProviderId): boolean {
    return this.adapterAvailability.get(provider) === true;
  }

  getStatus(provider: StreamingProviderId): StreamingAccountStatus {
    const status = this.statuses.get(provider) ?? unsupportedStatus(provider);
    return { ...status };
  }

  async restore(provider: StreamingProviderId): Promise<StreamingAccountStatus> {
    const response = await this.fetcher(
      this.endpoint(provider, "status"),
      { method: "GET", credentials: "same-origin", cache: "no-store" },
    );
    const payload = await readResponse(response);
    this.applyResponse(provider, payload);
    return this.getStatus(provider);
  }

  async disconnect(provider: StreamingProviderId): Promise<void> {
    const response = await this.fetcher(
      this.endpoint(provider, "disconnect"),
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const payload = await readResponse(response);
    this.applyResponse(provider, payload);
  }

  private endpoint(provider: StreamingProviderId, action: "status" | "disconnect"): string {
    if (!PROVIDERS.includes(provider)) throw new Error("Unsupported streaming account provider.");
    return `${this.basePath}/${provider}/${action}`;
  }

  private applyResponse(provider: StreamingProviderId, payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      throw new Error("Local streaming account API returned an invalid response.");
    }
    const result = payload as Partial<WebAccountStatusResponse>;
    if (result.provider !== provider || typeof result.adapterAvailable !== "boolean" ||
        !result.status || result.status.provider !== provider) {
      throw new Error("Local streaming account API returned an invalid account status.");
    }
    this.adapterAvailability.set(provider, result.adapterAvailable);
    this.statuses.set(provider, { ...result.status });
  }
}

async function readResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Local streaming account API returned invalid JSON.");
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" &&
      typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : "Local streaming account API request failed.";
    throw new Error(message);
  }
  return payload;
}

function unsupportedStatus(provider: StreamingProviderId): StreamingAccountStatus {
  return {
    provider,
    connected: false,
    connectedAt: null,
    expiresAt: null,
    accountLabel: null,
    state: "unsupported",
    errorMessage: null,
  };
}
