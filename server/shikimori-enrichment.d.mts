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
  id: number;
  myanimelist_id?: number | null;
}

export function enrichShikimoriAnimeRates(
  rates: ShikimoriAnimeRate[],
  fetchAnimeBatch: (ids: number[]) => Promise<ShikimoriAnimeDetails[]>,
  batchSize?: number,
): Promise<ShikimoriAnimeRate[]>;
