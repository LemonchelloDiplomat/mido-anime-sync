export type SyncProvider = "mal" | "anilist" | "shikimori";

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

export type AnimeSeason = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export interface AnimeFuzzyDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

/** A provider-native score. The original value and scale are never discarded. */
export interface AnimeProviderScore {
  value: number;
  scale: number;
  normalizedValue: number;
  kind?: "average" | "mean" | "site";
  voteCount?: number | null;
  updatedAt?: string | null;
}

export interface AnimeProviderMetrics {
  averageScore?: AnimeProviderScore | null;
  meanScore?: AnimeProviderScore | null;
  rank?: number | null;
  popularity?: number | null;
  members?: number | null;
  favorites?: number | null;
}

export interface AnimeTag {
  name: string;
  category?: string | null;
  rank?: number | null;
  isSpoiler?: boolean;
  isAdult?: boolean;
}

export interface AnimeCompany {
  name: string;
  externalId?: string | null;
  role?: string | null;
}

export interface AnimeStaffMember {
  name: string;
  externalId?: string | null;
  role?: string | null;
  language?: string | null;
}

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
  episodesAired?: number | null;
  durationMinutes?: number | null;
  endDate?: string | null;
  season?: AnimeSeason | null;
  seasonYear?: number | null;
  sourceMaterial?: string | null;
  countryOfOrigin?: string | null;
  synopsis?: string | null;
  background?: string | null;
  bannerUrl?: string | null;
  genres?: string[];
  themes?: string[];
  demographics?: string[];
  tags?: AnimeTag[];
  studios?: AnimeCompany[];
  producers?: AnimeCompany[];
  licensors?: AnimeCompany[];
  staff?: AnimeStaffMember[];
  providerScores?: Partial<Record<ServiceId, AnimeProviderMetrics>>;
  /** Bounded JSON-safe provider payloads retain fields not yet mapped to the common model. */
  providerMetadata?: Partial<Record<ServiceId, Record<string, unknown>>>;
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
  /** Cross-provider fields with equivalent meaning and compatible semantics. */
  sharedMetadata?: SharedAnimeEntryMetadata;
  /** Fields whose meaning or behavior belongs to one provider only. */
  sourceMetadata?: Record<string, unknown>;
}

export interface SharedAnimeEntryMetadata {
  /** Total number of completed rewatches, where supported by the provider. */
  rewatchCount?: number;
  /** Calendar date when the user started watching this entry. */
  startedAt?: string | null;
  /** Calendar date when the user completed this entry. */
  completedAt?: string | null;
}

export type AnimeSourceEntry = AnimeListEntry;

export type SyncOperationStatus = "pending" | "in_progress" | "succeeded" | "failed" | "cancelled";
export type SyncOperationDirection = "local" | "remote";
export type SyncOperationKind = "create" | "update" | "delete";

export interface SyncOperation {
  id: string;
  sessionId: string;
  provider: SyncProvider;
  direction: SyncOperationDirection;
  kind: SyncOperationKind;
  animeId: string;
  externalId?: string;
  entry: AnimeListEntry;
  anime?: AnimeIdentity;
  status: SyncOperationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type SyncSessionStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface SyncDeletionIntent {
  id: string;
  provider: SyncProvider;
  animeId: string;
  externalId: string;
  anime: AnimeIdentity;
  entry: AnimeListEntry;
  createdAt: string;
}

export interface SyncSession {
  sessionId: string;
  provider: SyncProvider;
  status: SyncSessionStatus;
  startedAt: string;
  finishedAt?: string;
  operationCount: number;
  succeededCount: number;
  failedCount: number;
  pendingCount: number;
  unchangedCount: number;
  conflictCount: number;
  recoveredCount: number;
  error?: string;
}

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
  delete: boolean;
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
  deleteEntry?(externalId: string, entryId?: number): Promise<void>;
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
  /** Pending explicit local deletions that must be confirmed on the provider at next sync. */
  deletionIntents?: SyncDeletionIntent[];
}

export type AnimeSnapshot = AnimeSnapshotV2 | AnimeSnapshotV3 | AnimeSnapshotV4;
