export interface ShikimoriAnimeRate {
  id: number;
  anime: {
    id: number;
    myanimelist_id?: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ShikimoriAnimeDetails {
  id: number | string;
  myanimelist_id?: number | string | null;
}

export function enrichShikimoriAnimeRates(
  rates: ShikimoriAnimeRate[],
  fetchAnimeBatch: (ids: number[]) => Promise<unknown>,
  fetchAnimeById: (id: number) => Promise<unknown>,
  batchSize?: number,
): Promise<ShikimoriAnimeRate[]>;

export interface ShikimoriIdentityCoverage {
  total: number;
  withMyAnimeListId: number;
  withoutMyAnimeListId: number;
  sampleMissingAnimeIds: number[];
}

export function getShikimoriIdentityCoverage(
  rates: ShikimoriAnimeRate[],
): ShikimoriIdentityCoverage;
