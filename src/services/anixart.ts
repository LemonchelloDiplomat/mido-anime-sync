import type {
  StreamingCatalogProvider,
  StreamingSearchQuery,
  StreamingSearchResult,
  StreamingTitle,
  StreamingTitleDetails,
} from "./streaming-provider.js";

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { ...(signal ? { signal } : {}), headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Локальный сервер AnixART: HTTP " + response.status);
  return payload as T;
}

export class AnixArtCatalogProvider implements StreamingCatalogProvider {
  readonly id = "anixart" as const;
  readonly name = "AnixART";
  readonly capabilities = {
    catalogSearch: true,
    titleDetails: true,
    seasonsAndEpisodes: true,
    voiceTracks: true,
  };

  async search(query: StreamingSearchQuery): Promise<StreamingSearchResult> {
    const params = new URLSearchParams({ q: query.query.trim() });
    const payload = await request<{ items: StreamingTitle[]; page: number; hasNextPage: boolean }>(
      "/api/anixart/search?" + params,
      query.signal,
    );
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      page: Number(payload.page) || 1,
      hasNextPage: Boolean(payload.hasNextPage),
    };
  }

  async getTitle(externalId: string, signal?: AbortSignal): Promise<StreamingTitleDetails> {
    if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(externalId)) throw new Error("Некорректный AnixART slug.");
    const payload = await request<StreamingTitleDetails>(
      "/api/anixart/anime/" + encodeURIComponent(externalId),
      signal,
    );
    if (payload.provider !== "anixart" || !payload.externalId || !payload.title || !Array.isArray(payload.seasons) || !Array.isArray(payload.voices)) {
      throw new Error("AnixART вернул карточку аниме в неожиданном формате.");
    }
    return payload;
  }
}
