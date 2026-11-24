import type { AnimeIdentity } from "../core/types.js";
import type {
  StreamingCatalogProvider,
  StreamingSearchQuery,
  StreamingSearchResult,
  StreamingTitle,
  StreamingTitleDetails,
  StreamingVoice,
} from "./streaming-provider.js";

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { ...(signal ? { signal } : {}), headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Локальный сервер AnimeGO: HTTP " + response.status);
  return payload as T;
}

export class AnimeGoCatalogProvider implements StreamingCatalogProvider {
  readonly id = "animego" as const;
  readonly name = "AnimeGO";
  readonly capabilities = {
    catalogSearch: true,
    titleDetails: true,
    seasonsAndEpisodes: true,
    voiceTracks: true,
  };

  async search(query: StreamingSearchQuery): Promise<StreamingSearchResult> {
    const params = new URLSearchParams({ q: query.query.trim() });
    const payload = await request<{ items: StreamingTitle[]; page: number; hasNextPage: boolean }>(
      "/api/animego/search?" + params,
      query.signal,
    );
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      page: Number(payload.page) || 1,
      hasNextPage: Boolean(payload.hasNextPage),
    };
  }

  async getMetadata(externalId: string, signal?: AbortSignal): Promise<StreamingTitle & { identity: AnimeIdentity }> {
    if (!/^[\p{L}\p{N}-]+$/u.test(externalId)) throw new Error("Некорректный AnimeGO slug.");
    const payload = await request<StreamingTitle & { identity: AnimeIdentity }>(
      "/api/animego/anime/" + encodeURIComponent(externalId) + "/metadata",
      signal,
    );
    if (payload.provider !== "animego" || !payload.externalId || !payload.title ||
        !payload.identity || payload.identity.externalIds.animego !== payload.externalId) {
      throw new Error("AnimeGO вернул метаданные в неожиданном формате.");
    }
    return payload;
  }

  async getEpisodeVoices(episodeId: string, signal?: AbortSignal): Promise<StreamingVoice[]> {
    if (!/^\d+$/.test(episodeId)) throw new Error("Некорректный AnimeGO episode ID.");
    const payload = await request<{ voices: StreamingVoice[] }>(
      "/api/animego/episode/" + encodeURIComponent(episodeId),
      signal,
    );
    return Array.isArray(payload.voices) ? payload.voices : [];
  }

  async getTitle(externalId: string, signal?: AbortSignal): Promise<StreamingTitleDetails> {
    if (!/^[\p{L}\p{N}-]+$/u.test(externalId)) throw new Error("Некорректный AnimeGO slug.");
    const payload = await request<StreamingTitleDetails>(
      "/api/animego/anime/" + encodeURIComponent(externalId),
      signal,
    );
    if (payload.provider !== "animego" || !payload.externalId || !payload.title || !Array.isArray(payload.seasons) || !Array.isArray(payload.voices)) {
      throw new Error("AnimeGO вернул карточку аниме в неожиданном формате.");
    }
    return payload;
  }
}
