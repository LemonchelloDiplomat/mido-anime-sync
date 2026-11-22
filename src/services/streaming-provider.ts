import type { AnimeIdentity, AnimeListEntry, ServiceId } from "../core/types.js";

/** Stable identifiers for streaming websites supported by the application. */
export type StreamingProviderId = "animego" | "yummyanime" | "anixart";

export interface StreamingProviderCapabilities {
  catalogSearch: boolean;
  titleDetails: boolean;
  seasonsAndEpisodes: boolean;
  voiceTracks: boolean;
  accountConnection: boolean;
  listImport: boolean;
  listWrite: boolean;
  watchProgressRead: boolean;
  watchProgressWrite: boolean;
  /** Explains unsupported or intentionally unavailable operations to the UI. */
  limitations?: string[];
}


/**
 * Verified capabilities, kept separate from catalog parsing. A public website
 * search result is not evidence that its user account or list API is available.
 */
export const STREAMING_PROVIDER_CAPABILITIES: Record<StreamingProviderId, StreamingProviderCapabilities> = {
  yummyanime: {
    catalogSearch: true, titleDetails: true, seasonsAndEpisodes: true, voiceTracks: true,
    accountConnection: true, listImport: true, listWrite: true,
    watchProgressRead: true, watchProgressWrite: true,
    limitations: [
      "API заявлен владельцем как personal use only; для коммерческого распространения нужно отдельное разрешение.",
      "Списки и избранное синхронизируются отдельно; изменение списка не обновляет прогресс и оценку.",
    ],
  },
  animego: {
    catalogSearch: true, titleDetails: true, seasonsAndEpisodes: true, voiceTracks: true,
    accountConnection: false, listImport: true, listWrite: false,
    watchProgressRead: true, watchProgressWrite: false,
    limitations: [
      "Импорт выполняется через браузерное расширение на открытой странице профиля, по одному статусному списку за раз.",
      "Обратная запись статусов, прогресса и оценок пока не реализована.",
    ],
  },
  anixart: {
    catalogSearch: true, titleDetails: true, seasonsAndEpisodes: true, voiceTracks: true,
    accountConnection: false, listImport: false, listWrite: false,
    watchProgressRead: true, watchProgressWrite: false,
    limitations: [
      "Интеграция относится к публичному сайту AnixART, а не к мобильному приложению.",
      "Синхронизация мобильного аккаунта не поддерживается.",
      "Состояние просмотра доступно через браузерное расширение.",
    ],
  },
};

export function getStreamingProviderCapabilities(provider: StreamingProviderId): StreamingProviderCapabilities {
  return structuredClone(STREAMING_PROVIDER_CAPABILITIES[provider]);
}

export interface StreamingSearchQuery {
  query: string;
  page?: number;
  signal?: AbortSignal;
}

export interface StreamingTitle {
  provider: StreamingProviderId;
  externalId: string;
  url: string;
  title: string;
  alternativeTitles: string[];
  posterUrl?: string | null;
  description?: string | null;
  year?: number | null;
  episodeCount?: number | null;
  /** Source-native catalog rating, normalized to a 0–10 scale when available. */
  rating?: number | null;
  /** Optional canonical identity candidate. Never auto-merge on title alone. */
  identity?: AnimeIdentity;
}

export interface StreamingEpisode {
  externalId: string;
  number: number;
  title?: string | null;
  url: string;
  seasonNumber?: number | null;
  durationSeconds?: number | null;
  /** Provider-specific voice/player variants belonging to this exact episode. */
  voiceTracks?: StreamingVoice[];
}

export interface StreamingSeason {
  number: number;
  title?: string | null;
  episodes: StreamingEpisode[];
}

export interface StreamingVoice {
  externalId: string;
  name: string;
  episodeIds?: string[];
  /** Temporary provider player URL; kept in memory and never persisted to the local library. */
  playerUrl?: string | null;
  playerName?: string | null;
}

export interface StreamingTitleDetails extends StreamingTitle {
  seasons: StreamingSeason[];
  voices: StreamingVoice[];
}

export interface StreamingSearchResult {
  items: StreamingTitle[];
  page: number;
  hasNextPage: boolean;
}

export type StreamingCatalogSort = "source" | "title" | "rating" | "year";

/** Sort a copy of provider results; unknown metadata always stays at the end. */
export function sortStreamingTitles(items: readonly StreamingTitle[], sort: StreamingCatalogSort, locale = "ru"): StreamingTitle[] {
  if (sort === "source") return [...items];
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    let comparison = 0;
    if (sort === "title") {
      comparison = left.item.title.localeCompare(right.item.title, locale, { numeric: true, sensitivity: "base" });
    } else {
      const leftValue = sort === "rating" ? left.item.rating : left.item.year;
      const rightValue = sort === "rating" ? right.item.rating : right.item.year;
      const leftKnown = typeof leftValue === "number" && Number.isFinite(leftValue);
      const rightKnown = typeof rightValue === "number" && Number.isFinite(rightValue);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (leftKnown && rightKnown) comparison = rightValue! - leftValue!;
    }
    return comparison || left.index - right.index;
  }).map(({ item }) => item);
}

export interface StreamingCatalogProvider {
  readonly id: StreamingProviderId;
  readonly name: string;
  readonly capabilities: Pick<
    StreamingProviderCapabilities,
    "catalogSearch" | "titleDetails" | "seasonsAndEpisodes" | "voiceTracks"
  >;
  search(query: StreamingSearchQuery): Promise<StreamingSearchResult>;
  getTitle(externalId: string, signal?: AbortSignal): Promise<StreamingTitleDetails>;
}

/** Account operations are separate from browsing. Credentials/tokens stay out of UI state. */
export interface StreamingAccountProvider {
  readonly id: StreamingProviderId;
  readonly capabilities: Pick<
    StreamingProviderCapabilities,
    "accountConnection" | "listImport" | "listWrite" |
    "watchProgressRead" | "watchProgressWrite"
  >;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  importList(signal?: AbortSignal): Promise<AnimeListEntry[]>;
  updateListEntry?(entry: AnimeListEntry): Promise<void>;
  importWatchProgress?(signal?: AbortSignal): Promise<AnimeListEntry[]>;
  updateWatchProgress?(entry: AnimeListEntry): Promise<void>;
}

/**
 * A website integration may expose catalog, account, or both.
 * The registry must not claim a capability until its implementation is verified.
 */
export interface StreamingProvider {
  readonly id: StreamingProviderId;
  readonly name: string;
  readonly websiteUrl: string;
  readonly capabilities: StreamingProviderCapabilities;
  readonly catalog?: StreamingCatalogProvider;
  readonly account?: StreamingAccountProvider;
}

export const STREAMING_PROVIDER_IDS: readonly StreamingProviderId[] = [
  "animego",
  "yummyanime",
  "anixart",
] as const;

export function isStreamingProviderId(value: unknown): value is StreamingProviderId {
  return value === "animego" || value === "yummyanime" || value === "anixart";
}

/** Keep streaming source IDs compatible with the existing local source-entry model. */
export function toStreamingServiceId(provider: StreamingProviderId): ServiceId {
  return provider;
}
