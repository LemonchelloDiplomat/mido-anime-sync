import type { SyncProvider } from "../core/types.js";

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
  shikimori: ProviderConnectionStatus;
}

const PROVIDER_ENDPOINTS: Record<SyncProvider, {
  start: string;
  list: string;
  entry: string;
  deleteEntry: string;
}> = {
  mal: {
    start: "/api/auth/mal/start",
    list: "/api/mal/list",
    entry: "/api/mal/entry",
    deleteEntry: "/api/mal/entry/delete",
  },
  anilist: {
    start: "/api/auth/anilist/start",
    list: "/api/anilist/list",
    entry: "/api/anilist/entry",
    deleteEntry: "/api/anilist/entry/delete",
  },
  shikimori: {
    start: "/api/auth/shikimori/start",
    list: "/api/shikimori/list",
    entry: "/api/shikimori/entry",
    deleteEntry: "/api/shikimori/entry/delete",
  },
};

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

export async function disconnectIntegration(provider: SyncProvider): Promise<void> {
  await request("/api/integrations/disconnect", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function connectIntegration(provider: SyncProvider): void {
  window.location.assign(PROVIDER_ENDPOINTS[provider].start);
}

export interface RemoteAccountListPayload {
  data: unknown[];
  count: number;
  scoreFormat?: string;
}

export function fetchAccountList(provider: SyncProvider): Promise<RemoteAccountListPayload> {
  return request<RemoteAccountListPayload>(PROVIDER_ENDPOINTS[provider].list);
}

export interface AccountEntryUpdate {
  externalId: string;
  status: "PLANNING" | "WATCHING" | "COMPLETED" | "ON_HOLD" | "DROPPED" | "REWATCHING";
  progress: number;
  score: number | null;
  favorite?: boolean;
  entryId?: number;
  /** Provider-specific metadata from that provider's own remote baseline. */
  sourceMetadata?: Record<string, unknown>;
}


export async function deleteAccountEntry(
  provider: SyncProvider,
  entry: { externalId: string; entryId?: number },
): Promise<{ ok: boolean }> {
  const result = await request<{ ok: boolean }>(
    PROVIDER_ENDPOINTS[provider].deleteEntry,
    {
      method: "POST",
      body: JSON.stringify(entry),
    },
  );
  if (!result.ok) throw new Error("Сервис не подтвердил удаление записи.");
  return result;
}

export async function updateAccountEntry(provider: SyncProvider, entry: AccountEntryUpdate): Promise<{ ok: boolean }> {
  const result = await request<{ ok: boolean }>(
    PROVIDER_ENDPOINTS[provider].entry,
    {
      method: "POST",
      body: JSON.stringify(entry),
    },
  );
  if (!result.ok) {
    throw new Error("Сервис не подтвердил сохранение записи.");
  }
  return result;
}
