export interface ShikimoriAnimeRate {
  id: number;
  anime: { id: number; myanimelist_id?: number | null; [key: string]: unknown };
  [key: string]: unknown;
}
export interface ShikimoriAnimeDetails {
  id: number | string;
  myanimelist_id?: number | string | null;
  malId?: number | string | null;
}
export const SHIKIMORI_USER_ANIME_RATES_QUERY: string;
export function fetchShikimoriAnimeRates(
  requestGraphql: (query: string, variables: { page: number; limit: number }) => Promise<unknown>,
  options?: { pageSize?: number; maxPages?: number },
): Promise<ShikimoriAnimeRate[]>;
export const SHIKIMORI_ANIME_IDENTITY_QUERY: string;
export function fetchShikimoriAnimeIdentityBatch(
  ids: number[],
  requestGraphql: (query: string, variables: { ids: string }) => Promise<unknown>,
): Promise<ShikimoriAnimeDetails[]>;
export function enrichShikimoriAnimeRates(
  rates: ShikimoriAnimeRate[],
  fetchAnimeBatch: (ids: number[]) => Promise<unknown>,
  fetchAnimeById: (id: number) => Promise<unknown>,
  batchSize?: number,
  options?: { resolveMissingIndividually?: boolean },
): Promise<ShikimoriAnimeRate[]>;
export interface ShikimoriIdentityCoverage {
  total: number;
  withMyAnimeListId: number;
  withoutMyAnimeListId: number;
  sampleMissingAnimeIds: number[];
}
export function getShikimoriIdentityCoverage(rates: ShikimoriAnimeRate[]): ShikimoriIdentityCoverage;
