import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeRelation,
  AnimeRelationType,
  AnimeSnapshotV1,
  AnimeSnapshotV2,
  AnimeSnapshotV3,
  AnimeSnapshotV4,
  AnimeSourceEntry,
  ConflictResolution,
  ServiceId,
} from "../core/types.js";

const VALID_STATUSES = [
  "PLANNING",
  "WATCHING",
  "COMPLETED",
  "ON_HOLD",
  "DROPPED",
  "REWATCHING",
] as const;

const VALID_AGE_RATINGS = ["G", "PG", "PG13", "R17", "R+"] as const;
const VALID_RELEASE_STATUSES = ["ONGOING", "ANNOUNCED", "RELEASED"] as const;

const VALID_FORMATS = [
  "TV",
  "MOVIE",
  "OVA",
  "ONA",
  "SPECIAL",
  "MUSIC",
  "UNKNOWN",
] as const;

const VALID_RELATION_TYPES: AnimeRelationType[] = [
  "SEQUEL",
  "PREQUEL",
  "SIDE_STORY",
  "ALTERNATIVE",
  "REMAKE",
  "SUMMARY",
  "SPIN_OFF",
];

const VALID_SOURCES: Array<ServiceId | "local"> = [
  "myanimelist",
  "anilist",
  "shikimori",
  "anixart",
  "animego",
  "yummyanime",
  "local",
];

function validateAnimeList(value: unknown): AnimeIdentity[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid anime list");
  }

  const anime = value as AnimeIdentity[];
  const ids = new Set<string>();

  for (const item of anime) {
    if (
      !item ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      !item.titles ||
      typeof item.titles !== "object" ||
      !Array.isArray(item.titles.synonyms)
    ) {
      throw new Error("Invalid anime record");
    }

    if (
      item.year !== undefined &&
      item.year !== null &&
      (!Number.isInteger(item.year) || item.year < 1900 || item.year > 2100)
    ) {
      throw new Error(`Invalid anime year: ${item.id}`);
    }

    if (
      item.format !== undefined &&
      !VALID_FORMATS.includes(item.format as (typeof VALID_FORMATS)[number])
    ) {
      throw new Error(`Invalid anime format: ${item.id}`);
    }

    if (item.genres !== undefined && (
      !Array.isArray(item.genres) ||
      item.genres.some((genre) => typeof genre !== "string" || genre.trim().length === 0)
    )) {
      throw new Error(`Invalid anime genres: ${item.id}`);
    }

    if (item.ageRating !== undefined && item.ageRating !== null &&
      !VALID_AGE_RATINGS.includes(item.ageRating as (typeof VALID_AGE_RATINGS)[number])) {
      throw new Error(`Invalid anime age rating: ${item.id}`);
    }

    if (item.posterUrl !== undefined && item.posterUrl !== null) {
      let validPosterUrl = false;
      try {
        const url = new URL(item.posterUrl);
        validPosterUrl = url.protocol === "https:" || url.protocol === "http:";
      } catch {
        validPosterUrl = false;
      }
      if (!validPosterUrl) throw new Error(`Invalid anime poster URL: ${item.id}`);
    }

    if (item.averageScore !== undefined && item.averageScore !== null &&
      (!Number.isFinite(item.averageScore) || item.averageScore < 0 || item.averageScore > 10)) {
      throw new Error(`Invalid anime average score: ${item.id}`);
    }

    if (item.startDate !== undefined && item.startDate !== null &&
      (!/^\\d{4}-\\d{2}-\\d{2}$/.test(item.startDate) ||
       !Number.isFinite(Date.parse(`${item.startDate}T00:00:00Z`)))) {
      throw new Error(`Invalid anime start date: ${item.id}`);
    }

    if (item.releaseStatus !== undefined &&
      !VALID_RELEASE_STATUSES.includes(item.releaseStatus as (typeof VALID_RELEASE_STATUSES)[number])) {
      throw new Error(`Invalid anime release status: ${item.id}`);
    }

    if (ids.has(item.id)) {
      throw new Error(`Duplicate anime ID: ${item.id}`);
    }

    ids.add(item.id);
  }

  return anime;
}

function validateEntries(
  value: unknown,
  animeIds: Set<string>,
): AnimeListEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid entries list");
  }

  const entries = value as AnimeListEntry[];

  for (const entry of entries) {
    validateEntry(entry);

    if (!animeIds.has(entry.animeId)) {
      throw new Error(`Entry references missing anime: ${entry.animeId}`);
    }
  }

  return entries;
}

function validateSourceEntries(
  value: unknown,
  animeIds: Set<string>,
): AnimeSourceEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid source entries list");
  }

  const entries = value as AnimeSourceEntry[];
  const keys = new Set<string>();

  for (const entry of entries) {
    validateEntry(entry);

    if (!animeIds.has(entry.animeId)) {
      throw new Error(
        `Source entry references missing anime: ${entry.animeId}`,
      );
    }

    const key = `${entry.animeId}:${entry.source}`;

    if (keys.has(key)) {
      throw new Error(`Duplicate source entry: ${key}`);
    }

    keys.add(key);
  }

  return entries;
}

function validateConflictResolutions(
  value: unknown,
  animeIds: Set<string>,
): ConflictResolution[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid conflict resolutions list");
  }

  const resolutions = value as ConflictResolution[];
  const resolvedAnimeIds = new Set<string>();

  for (const resolution of resolutions) {
    if (
      !resolution ||
      typeof resolution.animeId !== "string" ||
      !animeIds.has(resolution.animeId)
    ) {
      throw new Error("Conflict resolution references missing anime");
    }

    if (
      !VALID_STATUSES.includes(
        resolution.status as (typeof VALID_STATUSES)[number],
      )
    ) {
      throw new Error("Invalid conflict resolution status");
    }

    if (
      typeof resolution.fingerprint !== "string" ||
      resolution.fingerprint.length === 0 ||
      typeof resolution.resolvedAt !== "string" ||
      !Number.isFinite(Date.parse(resolution.resolvedAt))
    ) {
      throw new Error("Invalid conflict resolution metadata");
    }

    if (resolvedAnimeIds.has(resolution.animeId)) {
      throw new Error(`Duplicate conflict resolution: ${resolution.animeId}`);
    }

    resolvedAnimeIds.add(resolution.animeId);
  }

  return resolutions;
}

function validateAnimeRelations(
  value: unknown,
  animeIds: Set<string>,
): AnimeRelation[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid anime relations list");
  }

  const relations = value as AnimeRelation[];
  const relationIds = new Set<string>();
  const relationKeys = new Set<string>();

  for (const relation of relations) {
    if (
      !relation ||
      typeof relation.id !== "string" ||
      relation.id.trim().length === 0 ||
      typeof relation.sourceAnimeId !== "string" ||
      typeof relation.targetAnimeId !== "string"
    ) {
      throw new Error("Invalid anime relation");
    }

    if (
      !animeIds.has(relation.sourceAnimeId) ||
      !animeIds.has(relation.targetAnimeId)
    ) {
      throw new Error("Anime relation references missing anime");
    }

    if (relation.sourceAnimeId === relation.targetAnimeId) {
      throw new Error("Anime relation cannot reference itself");
    }

    if (!VALID_RELATION_TYPES.includes(relation.type as AnimeRelationType)) {
      throw new Error("Invalid anime relation type");
    }

    if (
      relation.seasonNumber !== undefined &&
      (!Number.isInteger(relation.seasonNumber) || relation.seasonNumber < 1)
    ) {
      throw new Error("Invalid anime relation season number");
    }

    if (
      relation.partNumber !== undefined &&
      (!Number.isInteger(relation.partNumber) || relation.partNumber < 1)
    ) {
      throw new Error("Invalid anime relation part number");
    }

    if (relationIds.has(relation.id)) {
      throw new Error(`Duplicate anime relation ID: ${relation.id}`);
    }

    const key = [
      relation.sourceAnimeId,
      relation.targetAnimeId,
      relation.type,
      relation.seasonNumber ?? "",
      relation.partNumber ?? "",
    ].join(":");

    if (relationKeys.has(key)) {
      throw new Error(`Duplicate anime relation: ${key}`);
    }

    relationIds.add(relation.id);
    relationKeys.add(key);
  }

  return relations;
}

export function validateSnapshot(value: unknown): AnimeSnapshotV4 {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid snapshot");
  }

  const v = value as Record<string, unknown>;

  if (
    (v.schemaVersion !== 1 &&
      v.schemaVersion !== 2 &&
      v.schemaVersion !== 3 &&
      v.schemaVersion !== 4) ||
    !Array.isArray(v.anime) ||
    !Array.isArray(v.entries)
  ) {
    throw new Error("Unsupported or malformed snapshot");
  }

  const anime = validateAnimeList(v.anime);
  const animeIds = new Set(anime.map((item) => item.id));
  const entries = validateEntries(v.entries, animeIds);

  let sourceEntries: AnimeSourceEntry[];
  let conflictResolutions: ConflictResolution[];

  if (v.schemaVersion === 1) {
    const oldSnapshot: AnimeSnapshotV1 = {
      schemaVersion: 1,
      exportedAt:
        typeof v.exportedAt === "string"
          ? v.exportedAt
          : new Date(0).toISOString(),
      anime,
      entries,
    };

    sourceEntries = structuredClone(oldSnapshot.entries);
    conflictResolutions = [];
  } else {
    const validatedSourceEntries =
      v.sourceEntries === undefined
        ? []
        : validateSourceEntries(v.sourceEntries, animeIds);

    sourceEntries =
      validatedSourceEntries.length > 0
        ? validatedSourceEntries
        : structuredClone(entries);

    if (v.schemaVersion === 3 || v.schemaVersion === 4) {
      conflictResolutions = validateConflictResolutions(
        v.conflictResolutions,
        animeIds,
      );
    } else {
      const oldSnapshot: AnimeSnapshotV2 = {
        schemaVersion: 2,
        exportedAt:
          typeof v.exportedAt === "string"
            ? v.exportedAt
            : new Date(0).toISOString(),
        anime,
        entries,
        sourceEntries,
      };

      sourceEntries = structuredClone(oldSnapshot.sourceEntries);
      conflictResolutions = [];
    }
  }

  const animeRelations =
    v.schemaVersion === 4
      ? validateAnimeRelations(v.animeRelations, animeIds)
      : [];

  const snapshot: AnimeSnapshotV4 = {
    schemaVersion: 4,
    exportedAt:
      typeof v.exportedAt === "string"
        ? v.exportedAt
        : new Date(0).toISOString(),
    anime: structuredClone(anime),
    entries: structuredClone(entries),
    sourceEntries: structuredClone(sourceEntries),
    conflictResolutions: structuredClone(conflictResolutions),
    animeRelations: structuredClone(animeRelations),
  };

  return snapshot;
}

export function validateEntry(entry: AnimeListEntry): void {
  if (
    !entry ||
    typeof entry.animeId !== "string" ||
    !Number.isInteger(entry.progress) ||
    entry.progress < 0
  ) {
    throw new Error("Invalid anime list entry");
  }

  if (
    entry.score !== null &&
    (!Number.isFinite(entry.score) || entry.score < 0 || entry.score > 100)
  ) {
    throw new Error("Score must be null or between 0 and 100");
  }

  if (
    !VALID_STATUSES.includes(entry.status as (typeof VALID_STATUSES)[number])
  ) {
    throw new Error("Invalid anime status");
  }

  if (
    typeof entry.favorite !== "boolean" ||
    typeof entry.updatedAt !== "string"
  ) {
    throw new Error("Invalid entry metadata");
  }

  if (!VALID_SOURCES.includes(entry.source)) {
    throw new Error("Invalid entry source");
  }

  if (
    entry.sourceMetadata !== undefined &&
    (typeof entry.sourceMetadata !== "object" ||
      entry.sourceMetadata === null ||
      Array.isArray(entry.sourceMetadata))
  ) {
    throw new Error("Invalid source metadata");
  }
}
