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

export async function disconnectIntegration(provider: SyncProvider | "shikimori"): Promise<void> {
  await request("/api/integrations/disconnect", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function connectIntegration(provider: SyncProvider): void {
  window.location.assign("/api/auth/" + provider + "/start");
}

export interface RemoteAccountListPayload {
  data: unknown[];
  count: number;
  scoreFormat?: string;
}

export function fetchAccountList(provider: SyncProvider): Promise<RemoteAccountListPayload> {
  const endpoint = provider === "mal" ? "/api/mal/list" : provider === "anilist" ? "/api/anilist/list" : "/api/shikimori/list";
  return request<RemoteAccountListPayload>(endpoint);
}

export interface AccountEntryUpdate {
  externalId: string;
  status: "PLANNING" | "WATCHING" | "COMPLETED" | "ON_HOLD" | "DROPPED" | "REWATCHING";
  progress: number;
  score: number | null;
  favorite?: boolean;
  entryId?: number;
}


export async function deleteAccountEntry(
  provider: SyncProvider,
  entry: { externalId: string; entryId?: number },
): Promise<{ ok: boolean }> {
  const result = await request<{ ok: boolean }>(
    provider === "mal" ? "/api/mal/entry/delete" : provider === "anilist" ? "/api/anilist/entry/delete" : "/api/shikimori/entry/delete",
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
    provider === "mal" ? "/api/mal/entry" : provider === "anilist" ? "/api/anilist/entry" : "/api/shikimori/entry",
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
