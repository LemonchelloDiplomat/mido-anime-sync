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
  SyncDeletionIntent,
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
  const externalIds = new Set<string>();

  for (const item of anime) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      !item.titles ||
      typeof item.titles !== "object" ||
      Array.isArray(item.titles) ||
      !Array.isArray(item.titles.synonyms) ||
      item.titles.synonyms.some(
        (synonym) => typeof synonym !== "string",
      ) ||
      ["romaji", "english", "native"].some(
        (key) =>
          item.titles[key as keyof typeof item.titles] !== undefined &&
          typeof item.titles[key as keyof typeof item.titles] !== "string",
      ) ||
      !item.externalIds ||
      typeof item.externalIds !== "object" ||
      Array.isArray(item.externalIds)
    ) {
      throw new Error("Invalid anime record");
    }

    for (const [service, externalId] of Object.entries(item.externalIds)) {
      if (
        !VALID_SOURCES.includes(service as (typeof VALID_SOURCES)[number]) ||
        service === "local" ||
        typeof externalId !== "string" ||
        externalId.trim().length === 0
      ) {
        throw new Error(`Invalid anime external ID: ${item.id}`);
      }

      const externalIdKey = JSON.stringify([service, externalId]);
      if (externalIds.has(externalIdKey)) {
        throw new Error(`Duplicate anime external ID: ${service}:${externalId}`);
      }
      externalIds.add(externalIdKey);
    }

    if (
      item.episodes !== undefined &&
      item.episodes !== null &&
      (!Number.isInteger(item.episodes) || item.episodes < 0)
    ) {
      throw new Error(`Invalid anime episode count: ${item.id}`);
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

    if (item.startDate !== undefined && item.startDate !== null) {
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.startDate);
      const parsedDate = new Date(`${item.startDate}T00:00:00Z`);
      const validDate = dateMatch !== null &&
        parsedDate.getUTCFullYear() === Number(dateMatch[1]) &&
        parsedDate.getUTCMonth() + 1 === Number(dateMatch[2]) &&
        parsedDate.getUTCDate() === Number(dateMatch[3]);
      if (!validDate) throw new Error(`Invalid anime start date: ${item.id}`);
    }

    if (item.releaseStatus !== undefined &&
      !VALID_RELEASE_STATUSES.includes(item.releaseStatus as (typeof VALID_RELEASE_STATUSES)[number])) {
      throw new Error(`Invalid anime release status: ${item.id}`);
    }

    const validCalendarDate = (value: unknown): boolean => {
      if (typeof value !== "string") return false;
      const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(value);
      if (!match) return false;
      const date = new Date(value + "T00:00:00.000Z");
      return Number.isFinite(date.getTime()) &&
        date.getUTCFullYear() === Number(match[1]) &&
        date.getUTCMonth() + 1 === Number(match[2]) &&
        date.getUTCDate() === Number(match[3]);
    };
    for (const [field, dateValue] of [["endDate", item.endDate]] as const) {
      if (dateValue !== undefined && dateValue !== null && !validCalendarDate(dateValue)) {
        throw new Error(`Invalid anime ${field}: ${item.id}`);
      }
    }
    if (item.season !== undefined && item.season !== null &&
      !["WINTER", "SPRING", "SUMMER", "FALL"].includes(item.season)) {
      throw new Error(`Invalid anime season: ${item.id}`);
    }
    for (const [field, numberValue] of [
      ["episodesAired", item.episodesAired],
      ["durationMinutes", item.durationMinutes],
      ["seasonYear", item.seasonYear],
    ] as const) {
      if (numberValue !== undefined && numberValue !== null &&
        (!Number.isSafeInteger(numberValue) || numberValue < 0 || numberValue > 10000)) {
        throw new Error(`Invalid anime ${field}: ${item.id}`);
      }
    }
    for (const [field, stringValue] of [
      ["sourceMaterial", item.sourceMaterial],
      ["countryOfOrigin", item.countryOfOrigin],
      ["synopsis", item.synopsis],
      ["background", item.background],
      ["bannerUrl", item.bannerUrl],
    ] as const) {
      if (stringValue !== undefined && stringValue !== null &&
        (typeof stringValue !== "string" || stringValue.length > (field === "synopsis" || field === "background" ? 50000 : 2048))) {
        throw new Error(`Invalid anime ${field}: ${item.id}`);
      }
    }
    for (const [field, values] of [
      ["themes", item.themes],
      ["demographics", item.demographics],
    ] as const) {
      if (values !== undefined && (!Array.isArray(values) ||
        values.length > 500 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 200))) {
        throw new Error(`Invalid anime ${field}: ${item.id}`);
      }
    }
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 1000 ||
      item.tags.some((tag) => !tag || typeof tag !== "object" || typeof tag.name !== "string" ||
        !tag.name.trim() || tag.name.length > 200 ||
        (tag.category != null && (typeof tag.category !== "string" || tag.category.length > 200)) ||
        (tag.rank != null && (!Number.isFinite(tag.rank) || tag.rank < 0 || tag.rank > 100)) ||
        (tag.isSpoiler !== undefined && typeof tag.isSpoiler !== "boolean") ||
        (tag.isAdult !== undefined && typeof tag.isAdult !== "boolean")))) {
      throw new Error(`Invalid anime tags: ${item.id}`);
    }
    for (const [field, values] of [
      ["studios", item.studios],
      ["producers", item.producers],
      ["licensors", item.licensors],
    ] as const) {
      if (values !== undefined && (!Array.isArray(values) || values.length > 1000 ||
        values.some((value) => !value || typeof value !== "object" ||
          typeof value.name !== "string" || !value.name.trim() || value.name.length > 300 ||
          (value.externalId != null && (typeof value.externalId !== "string" || value.externalId.length > 200)) ||
          (value.role != null && (typeof value.role !== "string" || value.role.length > 200))))) {
        throw new Error(`Invalid anime ${field}: ${item.id}`);
      }
    }
    if (item.staff !== undefined && (!Array.isArray(item.staff) || item.staff.length > 5000 ||
      item.staff.some((person) => !person || typeof person !== "object" ||
        typeof person.name !== "string" || !person.name.trim() || person.name.length > 300 ||
        (person.externalId != null && (typeof person.externalId !== "string" || person.externalId.length > 200)) ||
        (person.role != null && (typeof person.role !== "string" || person.role.length > 200)) ||
        (person.language != null && (typeof person.language !== "string" || person.language.length > 100))))) {
      throw new Error(`Invalid anime staff: ${item.id}`);
    }
    if (item.providerScores !== undefined) {
      if (!item.providerScores || typeof item.providerScores !== "object" || Array.isArray(item.providerScores)) {
        throw new Error(`Invalid anime provider scores: ${item.id}`);
      }
      for (const [provider, metrics] of Object.entries(item.providerScores)) {
        if (!VALID_SOURCES.includes(provider as (typeof VALID_SOURCES)[number]) ||
          provider === "local" || !metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
          throw new Error(`Invalid anime provider score source: ${item.id}`);
        }
        for (const key of ["averageScore", "meanScore"] as const) {
          const score = metrics[key];
          if (score == null) continue;
          if (typeof score !== "object" || !Number.isFinite(score.value) ||
            !Number.isFinite(score.scale) || score.scale <= 0 || score.scale > 1000 ||
            score.value < 0 || score.value > score.scale ||
            !Number.isFinite(score.normalizedValue) || score.normalizedValue < 0 ||
            score.normalizedValue > 100 ||
            Math.abs(score.normalizedValue - score.value / score.scale * 100) > 0.11 ||
            (score.voteCount != null && (!Number.isSafeInteger(score.voteCount) || score.voteCount < 0)) ||
            (score.kind !== undefined && !["average", "mean", "site"].includes(score.kind)) ||
            (score.updatedAt != null && (typeof score.updatedAt !== "string" || !Number.isFinite(Date.parse(score.updatedAt))))) {
            throw new Error(`Invalid anime provider score value: ${item.id}`);
          }
        }
        for (const key of ["rank", "popularity", "members", "favorites"] as const) {
          const count = metrics[key];
          if (count != null && (!Number.isSafeInteger(count) || count < 0)) {
            throw new Error(`Invalid anime provider metric ${key}: ${item.id}`);
          }
        }
      }
    }
    if (item.providerMetadata !== undefined) {
      if (!item.providerMetadata || typeof item.providerMetadata !== "object" || Array.isArray(item.providerMetadata)) {
        throw new Error(`Invalid anime provider metadata: ${item.id}`);
      }
      let totalBytes = 0;
      for (const [provider, payload] of Object.entries(item.providerMetadata)) {
        if (!VALID_SOURCES.includes(provider as (typeof VALID_SOURCES)[number]) ||
          provider === "local" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error(`Invalid anime provider metadata source: ${item.id}`);
        }
        let serialized: string;
        try { serialized = JSON.stringify(payload); } catch { throw new Error(`Invalid anime provider metadata JSON: ${item.id}`); }
        if (serialized === undefined || serialized.length > 131072) {
          throw new Error(`Anime provider metadata is too large: ${item.id}`);
        }
        totalBytes += serialized.length;
      }
      if (totalBytes > 262144) throw new Error(`Anime provider metadata exceeds the storage limit: ${item.id}`);
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
  const entryAnimeIds = new Set<string>();

  for (const entry of entries) {
    validateEntry(entry);

    if (!animeIds.has(entry.animeId)) {
      throw new Error(`Entry references missing anime: ${entry.animeId}`);
    }

    if (entryAnimeIds.has(entry.animeId)) {
      throw new Error(`Duplicate anime entry: ${entry.animeId}`);
    }

    entryAnimeIds.add(entry.animeId);
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

function validateDeletionIntents(
  value: unknown,
  anime: AnimeIdentity[],
  animeIds: Set<string>,
): SyncDeletionIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid deletion intents list");

  const intents = value as SyncDeletionIntent[];
  const intentIds = new Set<string>();
  const providerKeys = new Set<string>();

  for (const intent of intents) {
    if (
      !intent ||
      typeof intent.id !== "string" ||
      intent.id.trim().length === 0 ||
      (intent.provider !== "mal" && intent.provider !== "anilist" && intent.provider !== "shikimori") ||
      typeof intent.animeId !== "string" ||
      intent.animeId.trim().length === 0 ||
      typeof intent.externalId !== "string" ||
      intent.externalId.trim().length === 0 ||
      typeof intent.createdAt !== "string" ||
      !Number.isFinite(Date.parse(intent.createdAt)) ||
      !intent.anime ||
      typeof intent.anime !== "object" ||
      !intent.entry ||
      typeof intent.entry !== "object"
    ) {
      throw new Error("Invalid deletion intent");
    }

    if (intentIds.has(intent.id)) throw new Error("Duplicate deletion intent ID");
    intentIds.add(intent.id);

    if (animeIds.has(intent.animeId) || intent.anime.id !== intent.animeId || intent.entry.animeId !== intent.animeId) {
      throw new Error("Deletion intent references an anime that is still in the library");
    }

    validateAnimeList([intent.anime]);
    validateEntry(intent.entry);

    const service = intent.provider === "mal" ? "myanimelist" : intent.provider === "anilist" ? "anilist" : "shikimori";
    if (intent.entry.source !== service || intent.anime.externalIds[service] !== intent.externalId) {
      throw new Error("Deletion intent provider identity does not match its anime and entry");
    }

    if (anime.some((item) => item.externalIds[service] === intent.externalId)) {
      throw new Error("Deletion intent external ID is already assigned to another library anime");
    }

    const providerKey = JSON.stringify([intent.provider, intent.externalId]);
    if (providerKeys.has(providerKey)) throw new Error("Duplicate provider deletion intent");
    providerKeys.add(providerKey);
  }

  return intents.map((intent) => structuredClone(intent));
}

export function validateSnapshot(value: unknown): AnimeSnapshotV4 {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid snapshot");
  }

  const v = value as Record<string, unknown>;

  if (
    v.exportedAt !== undefined &&
    (typeof v.exportedAt !== "string" ||
      !Number.isFinite(Date.parse(v.exportedAt)))
  ) {
    throw new Error("Invalid snapshot export date");
  }

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

    // A snapshot may contain a mixture of modern provider baselines and
    // legacy aggregate-only entries. Preserve the latter per anime instead of
    // treating the presence of any source entry as proof that every anime has
    // provider-level data.
    const sourceEntryAnimeIds = new Set(
      validatedSourceEntries.map((entry) => entry.animeId),
    );
    sourceEntries = [
      ...validatedSourceEntries.map((entry) => structuredClone(entry)),
      ...entries
        .filter((entry) => !sourceEntryAnimeIds.has(entry.animeId))
        .map((entry) => structuredClone(entry)),
    ];

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
  const deletionIntents = validateDeletionIntents(v.deletionIntents, anime, animeIds);

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
    deletionIntents: structuredClone(deletionIntents),
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
    (typeof entry.score !== "number" ||
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      entry.score > 100)
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
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt))
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

  if (entry.sharedMetadata !== undefined) {
    const shared = entry.sharedMetadata;
    if (!shared || typeof shared !== "object" || Array.isArray(shared)) {
      throw new Error("Invalid shared entry metadata");
    }
    if (shared.rewatchCount !== undefined &&
      (!Number.isSafeInteger(shared.rewatchCount) || shared.rewatchCount < 0)) {
      throw new Error("Invalid shared rewatch count");
    }
    for (const [field, value] of [
      ["startedAt", shared.startedAt],
      ["completedAt", shared.completedAt],
    ] as const) {
      if (value !== undefined && value !== null) {
        const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
        const date = match ? new Date(value + "T00:00:00.000Z") : null;
        if (!match || !date || !Number.isFinite(date.getTime()) ||
          date.getUTCFullYear() !== Number(match[1]) ||
          date.getUTCMonth() + 1 !== Number(match[2]) ||
          date.getUTCDate() !== Number(match[3])) {
          throw new Error("Invalid shared entry date: " + field);
        }
      }
    }
  }
}
