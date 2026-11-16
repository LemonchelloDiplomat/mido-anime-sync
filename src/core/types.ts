export type ServiceId =
  | "myanimelist"
  | "anilist"
  | "shikimori"
  | "anixart"
  | "animego"
  | "yummyanime";

export type AnimeStatus =
  | "PLANNING"
  | "WATCHING"
  | "COMPLETED"
  | "ON_HOLD"
  | "DROPPED"
  | "REWATCHING";

export type AnimeFormat =
  | "TV"
  | "MOVIE"
  | "OVA"
  | "ONA"
  | "SPECIAL"
  | "MUSIC"
  | "UNKNOWN";

export type AnimeAgeRating = "G" | "PG" | "PG13" | "R17" | "R+";
export type AnimeReleaseStatus = "ONGOING" | "ANNOUNCED" | "RELEASED";

export interface AnimeIdentity {
  id: string;
  year?: number | null;
  format?: AnimeFormat;
  titles: {
    romaji?: string;
    english?: string;
    native?: string;
    synonyms: string[];
  };
  externalIds: Partial<Record<ServiceId, string>>;
  episodes?: number | null;
  genres?: string[];
  ageRating?: AnimeAgeRating | null;
  posterUrl?: string | null;
  averageScore?: number | null;
  startDate?: string | null;
  releaseStatus?: AnimeReleaseStatus;
}

export interface AnimeListEntry {
  animeId: string;
  status: AnimeStatus;
  progress: number;
  score: number | null;
  favorite: boolean;
  updatedAt: string;
  source: ServiceId | "local";
  sourceMetadata?: Record<string, unknown>;
}

export type AnimeSourceEntry = AnimeListEntry;

export type AnimeRelationType =
  | "SEQUEL"
  | "PREQUEL"
  | "SIDE_STORY"
  | "ALTERNATIVE"
  | "REMAKE"
  | "SUMMARY"
  | "SPIN_OFF";

export interface AnimeRelation {
  id: string;
  sourceAnimeId: string;
  targetAnimeId: string;
  type: AnimeRelationType;
  seasonNumber?: number;
  partNumber?: number;
}

export interface SyncConflict {
  animeId: string;
  field: "status" | "progress" | "score" | "favorite";
  localValue: unknown;
  remoteValue: unknown;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  reason: "same_timestamp" | "concurrent_change" | "unknown_order";
}

export interface ConflictResolution {
  animeId: string;
  status: AnimeStatus;
  fingerprint: string;
  resolvedAt: string;
}

export interface AdapterCapabilities {
  read: boolean;
  create: boolean;
  updateStatus: boolean;
  updateProgress: boolean;
  updateScore: boolean;
  updateFavorite: boolean;
  importFile: boolean;
  exportFile: boolean;
  notes?: string;
}

export interface AnimeServiceAdapter {
  readonly service: ServiceId;
  readonly capabilities: AdapterCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fetchList(): Promise<AnimeListEntry[]>;
  upsertEntry(entry: AnimeListEntry): Promise<void>;
}

export interface AnimeSnapshotV1 {
  schemaVersion: 1;
  exportedAt: string;
  anime: AnimeIdentity[];
  entries: AnimeListEntry[];
}

export interface AnimeSnapshotV2 {
  schemaVersion: 2;
  exportedAt: string;
  anime: AnimeIdentity[];
  entries: AnimeListEntry[];
  sourceEntries: AnimeSourceEntry[];
}

export interface AnimeSnapshotV3 {
  schemaVersion: 3;
  exportedAt: string;
  anime: AnimeIdentity[];
  entries: AnimeListEntry[];
  sourceEntries: AnimeSourceEntry[];
  conflictResolutions: ConflictResolution[];
}

export interface AnimeSnapshotV4 {
  schemaVersion: 4;
  exportedAt: string;
  anime: AnimeIdentity[];
  entries: AnimeListEntry[];
  sourceEntries: AnimeSourceEntry[];
  conflictResolutions: ConflictResolution[];
  animeRelations: AnimeRelation[];
}

export type AnimeSnapshot = AnimeSnapshotV2 | AnimeSnapshotV3 | AnimeSnapshotV4;
