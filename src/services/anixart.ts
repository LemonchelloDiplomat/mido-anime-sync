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

export interface AnixArtPlayerCatalog {
  slug: string;
  title: string;
  seasons: Array<{
    number: number;
    episodes: Array<{
      number: number;
      title: string;
      voices: Array<{ name: string; type: string | null }>;
    }>;
  }>;
  current: { season: number | null; episode: number | null; voice: string | null };
  receivedAt: string;
}

export async function getAnixArtPlayerCatalog(
  slug: string,
  signal?: AbortSignal,
): Promise<AnixArtPlayerCatalog | null> {
  if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug)) throw new Error("Некорректный AnixART slug.");
  const payload = await request<{ catalog: AnixArtPlayerCatalog | null }>(
    "/api/anixart/player-catalog?slug=" + encodeURIComponent(slug),
    signal,
  );
  return payload.catalog ?? null;
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
