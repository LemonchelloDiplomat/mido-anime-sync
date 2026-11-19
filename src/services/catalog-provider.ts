import type { AnimeIdentity } from "../core/types.js";

export interface CatalogMetadataMatch {
  animeId: string;
  metadata: AnimeIdentity;
}

export interface CatalogMetadataBatch {
  completed: number;
  total: number;
  matched: number;
  missing: number;
  matches: CatalogMetadataMatch[];
}

export interface CatalogMetadataProviderOptions {
  signal?: AbortSignal;
  onBatch?: (batch: CatalogMetadataBatch) => void | Promise<void>;
}

/**
 * A catalog provider enriches local anime by exact external identifiers.
 * Providers must never modify personal watch-list entries.
 */
export interface CatalogMetadataProvider {
  readonly id: string;
  readonly name: string;
  enrich(
    anime: AnimeIdentity[],
    options?: CatalogMetadataProviderOptions,
  ): Promise<void>;
}
