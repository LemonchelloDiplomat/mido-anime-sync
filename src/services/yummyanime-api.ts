import type { StreamingSearchResult, StreamingTitleDetails } from "./streaming-provider.js";
import { parseYummyDetails, parseYummySearch, parseYummyWatchHistory } from "./yummyanime.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Локальный сервер YummyAnime: HTTP " + response.status);
    Object.assign(error, { status: response.status, captchaRequired: Boolean(payload.captchaRequired), siteKey: payload.siteKey });
    throw error;
  }
  return payload as T;
}

export interface YummyAnimeConnectionStatus {
  configured: boolean;
  connected: boolean;
  username: string | null;
  userId: number | null;
  refreshedAt: number | null;
}

export function getYummyAnimeStatus(): Promise<YummyAnimeConnectionStatus> {
  return request("/api/yummyanime/status");
}

export function loginYummyAnime(login: string, password: string, captcha?: string): Promise<{ ok: boolean; username: string }> {
  return request("/api/yummyanime/login", {
    method: "POST",
    body: JSON.stringify({ login, password, ...(captcha ? { captcha } : {}) }),
  });
}

export function logoutYummyAnime(): Promise<{ ok: boolean }> {
  return request("/api/yummyanime/logout", { method: "POST" });
}

export async function searchYummyAnime(query: string, page = 1, signal?: AbortSignal): Promise<StreamingSearchResult> {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: "20",
    offset: String(Math.max(0, page - 1) * 20),
  });
  const payload = await request<unknown>("/api/yummyanime/search?" + params, { signal });
  return parseYummySearch(payload, page);
}

export async function getYummyAnimeTitle(externalId: string, signal?: AbortSignal): Promise<StreamingTitleDetails> {
  const payload = await request<{ detail: unknown; videos: unknown }>(
    "/api/yummyanime/anime/" + encodeURIComponent(externalId),
    { signal },
  );
  return parseYummyDetails(payload.detail, payload.videos);
}

export function fetchYummyAnimeLists(): Promise<{ profile: unknown; lists: unknown[]; entries: unknown[]; count: number }> {
  return request("/api/yummyanime/lists");
}

export async function fetchYummyAnimeHistory(limit = 100, offset = 0): Promise<import("../core/types.js").AnimeSnapshotV4> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const payload = await request<{ entries: unknown[] }>("/api/yummyanime/history?" + params);\n  return parseYummyWatchHistory({ response: payload.entries });
}

export function updateYummyAnimeList(animeId: string, listId: 0 | 1 | 2 | 3 | 5): Promise<{ ok: boolean }> {
  return request("/api/yummyanime/list", {
    method: "POST",
    body: JSON.stringify({ animeId, listId }),
  });
}

export function updateYummyAnimeProgress(videoId: string, time: number, duration: number): Promise<{ ok: boolean }> {
  return request("/api/yummyanime/progress", {
    method: "POST",
    body: JSON.stringify({ videoId, time, duration }),
  });
}
