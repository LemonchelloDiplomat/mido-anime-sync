export interface ProviderConnectionStatus {
  configured: boolean;
  connected: boolean;
  username: string | null;
  expiresAt?: number | null;
}

export interface IntegrationStatus {
  server: { ok: boolean; mode: string };
  myanimelist: ProviderConnectionStatus;
  anilist: ProviderConnectionStatus;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || ("Ошибка локального сервера: HTTP " + response.status));
  }
  return payload as T;
}

export function getIntegrationStatus(): Promise<IntegrationStatus> {
  return request<IntegrationStatus>("/api/integrations/status");
}

export async function disconnectIntegration(provider: "mal" | "anilist"): Promise<void> {
  await request("/api/integrations/disconnect", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function connectIntegration(provider: "mal" | "anilist"): void {
  window.location.assign("/api/auth/" + provider + "/start");
}

export interface RemoteAccountListPayload {
  data: unknown[];
  count: number;
  scoreFormat?: string;
}

export function fetchAccountList(provider: "mal" | "anilist"): Promise<RemoteAccountListPayload> {
  return request<RemoteAccountListPayload>(provider === "mal" ? "/api/mal/list" : "/api/anilist/list");
}

export interface AccountEntryUpdate {
  externalId: string;
  status: "PLANNING" | "WATCHING" | "COMPLETED" | "ON_HOLD" | "DROPPED" | "REWATCHING";
  progress: number;
  score: number | null;
  favorite?: boolean;
}

export function updateAccountEntry(provider: "mal" | "anilist", entry: AccountEntryUpdate): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(provider === "mal" ? "/api/mal/entry" : "/api/anilist/entry", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}
