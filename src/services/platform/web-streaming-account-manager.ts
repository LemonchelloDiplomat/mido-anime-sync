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

export interface AnimeGoAccountListResponse {
  provider: "animego";
  account: { userId: string; accountLabel: string | null };
  fetchedAt: string;
  lists: Array<{ listType: number; pageCount: number; itemCount: number }>;
  total: number;
  items: Array<{
    provider: "animego";
    listEntryId: string;
    animeId: string | null;
    animeSlug: string;
    url: string;
    title: string;
    alternativeTitle: string | null;
    posterUrl: string | null;
    listType: number;
    releaseStatus: string | null;
    episodesWatched: number | null;
    episodesTotal: number | null;
    progressText: string | null;
    score: number | null;
  }>;
}

/**
 * Browser facade for the local Node API. Credentials are sent only to the
 * loopback API over same-origin JSON; upstream requests and cookies stay on
 * the server and are never exposed to renderer JavaScript.
 */
export class WebApiStreamingAccountManager implements StreamingAccountManagerPort {
  private readonly adapterAvailability = new Map<StreamingProviderId, boolean>();
  private readonly statuses = new Map<StreamingProviderId, StreamingAccountStatus>();

  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
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

  async connect(provider: StreamingProviderId, input: unknown): Promise<StreamingAccountStatus> {
    if (provider !== "animego") {
      throw new Error("Авторизация этого провайдера не реализована.");
    }
    const response = await this.fetcher(this.endpoint(provider, "connect"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });
    const payload = await readResponse(response);
    this.applyResponse(provider, payload);
    return this.getStatus(provider);
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

  async fetchList(provider: StreamingProviderId): Promise<AnimeGoAccountListResponse> {
    if (provider !== "animego") throw new Error("Импорт списка этого провайдера не реализован.");
    const response = await this.fetcher(this.endpoint(provider, "list"), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    const payload = await readResponse(response);
    if (!payload || typeof payload !== "object" ||
        (payload as { provider?: unknown }).provider !== "animego" ||
        !Array.isArray((payload as { items?: unknown }).items) ||
        typeof (payload as { total?: unknown }).total !== "number") {
      throw new Error("Локальный API вернул некорректный список AnimeGO.");
    }
    return payload as AnimeGoAccountListResponse;
  }

  private endpoint(
    provider: StreamingProviderId,
    action: "status" | "connect" | "disconnect" | "list",
  ): string {
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

async function readResponse(response: Response): Promise<any> {
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
