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
