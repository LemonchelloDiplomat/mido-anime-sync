import type { AdapterCapabilities, ServiceId, SyncProvider } from "./types.js";

export interface SyncProviderDefinition {
  service: ServiceId;
  label: string;
  capabilities: AdapterCapabilities;
}

/**
 * One capability registry for account providers. UI and sync logic must not
 * assume that every service supports every field or operation.
 */
export const SYNC_PROVIDER_DEFINITIONS: Record<SyncProvider, SyncProviderDefinition> = {
  mal: {
    service: "myanimelist",
    label: "MyAnimeList",
    capabilities: {
      read: true,
      create: true,
      updateStatus: true,
      updateProgress: true,
      updateScore: true,
      updateFavorite: false,
      delete: true,
      importFile: true,
      exportFile: true,
      notes: "Scores are stored as integer values from 1 to 10.",
    },
  },
  anilist: {
    service: "anilist",
    label: "AniList",
    capabilities: {
      read: true,
      create: true,
      updateStatus: true,
      updateProgress: true,
      updateScore: true,
      updateFavorite: true,
      delete: true,
      importFile: true,
      exportFile: true,
    },
  },
  shikimori: {
    service: "shikimori",
    label: "Shikimori",
    capabilities: {
      read: true,
      create: true,
      updateStatus: true,
      updateProgress: true,
      updateScore: true,
      updateFavorite: false,
      delete: true,
      importFile: false,
      exportFile: false,
      notes: "Uses the Shikimori 10-point score scale. Favorites are not synchronized.",
    },
  },
};

export function getProviderServiceId(provider: SyncProvider): ServiceId {
  return SYNC_PROVIDER_DEFINITIONS[provider].service;
}

export function getProviderLabel(provider: SyncProvider): string {
  return SYNC_PROVIDER_DEFINITIONS[provider].label;
}

export function providerSupportsFavorite(provider: SyncProvider): boolean {
  return SYNC_PROVIDER_DEFINITIONS[provider].capabilities.updateFavorite;
}

export function providerUsesTenPointScore(provider: SyncProvider): boolean {
  return provider === "mal" || provider === "shikimori";
}
