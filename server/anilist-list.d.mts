export const ANILIST_LIST_CHUNK_SIZE: number;
export const ANILIST_LIST_MAX_CHUNKS: number;

export function fetchAniListAnimeList(args: {
  request: (
    query: string,
    variables: { userId: number; chunk: number; perChunk: number },
    accessToken: string,
  ) => Promise<{
    Viewer?: { mediaListOptions?: { scoreFormat?: string | null } | null } | null;
    MediaListCollection?: {
      hasNextChunk?: boolean | null;
      lists?: Array<{
        name: string;
        isCustomList?: boolean | null;
        isSplitCompletedList?: boolean | null;
        entries: unknown[];
        [key: string]: unknown;
      }> | null;
    } | null;
  }>,
  userId: number,
  accessToken: string,
}): Promise<{
  lists: Array<{ entries: unknown[]; [key: string]: unknown }>;
  scoreFormat: string;
  count: number;
}>;
