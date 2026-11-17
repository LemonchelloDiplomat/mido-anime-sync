import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { detectMaxProgressStatusConflicts } from "../core/conflicts.js";

import type {
  AnimeIdentity,
  AnimeListEntry,
  AnimeRelation,
  AnimeSnapshotV4,
  AnimeSourceEntry,
  AnimeStatus,
  ConflictResolution,
  SyncConflict,
  SyncOperation,
  SyncSession,
  SyncDeletionIntent,
} from "../core/types.js";

import { validateSnapshot, validateEntry } from "./snapshot-validation.js";

interface AnimeSyncDB extends DBSchema {
  anime: {
    key: string;
    value: AnimeIdentity;
  };

  entries: {
    key: string;
    value: AnimeListEntry;
  };

  sourceEntries: {
    key: [string, string];
    value: AnimeSourceEntry;
  };

  conflictResolutions: {
    key: string;
    value: ConflictResolution;
  };

  animeRelations: {
    key: string;
    value: AnimeRelation;
  };

  syncOperations: {
    key: string;
    value: SyncOperation;
    indexes: { "by-session": string; "by-status": string; "by-provider": string };
  };

  syncSessions: {
    key: string;
    value: SyncSession;
    indexes: { "by-started-at": string; "by-provider": string; "by-status": string };
  };
  deletionIntents: {
    key: string;
    value: SyncDeletionIntent;
    indexes: { "by-provider": string; "by-created-at": string };
  };
}

function getTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Создаёт отпечаток исходных записей.
 * Если статусы, прогресс или даты изменятся,
 * отпечаток станет другим.
 */
function createFingerprint(entries: AnimeSourceEntry[]): string {
  const normalized = [...entries]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((entry) => ({
      source: entry.source,
      status: entry.status,
      progress: entry.progress,
      updatedAt: entry.updatedAt,
    }));

  return JSON.stringify(normalized);
}

function mergeAnimeIdentity(
  existing: AnimeIdentity,
  incoming: AnimeIdentity,
): AnimeIdentity {
  const episodes =
    incoming.episodes != null ? incoming.episodes : existing.episodes;

  const year =
    incoming.year !== undefined && incoming.year !== null
      ? incoming.year
      : existing.year;

  const format =
    incoming.format !== undefined ? incoming.format : existing.format;
  const genres = [...new Set([...(existing.genres ?? []), ...(incoming.genres ?? [])])];
  const ageRating = incoming.ageRating ?? existing.ageRating;
  const posterUrl = incoming.posterUrl ?? existing.posterUrl;
  const averageScore = incoming.averageScore ?? existing.averageScore;
  const startDate = incoming.startDate ?? existing.startDate;
  const releaseStatus = incoming.releaseStatus ?? existing.releaseStatus;

  return {
    id: existing.id,

    titles: {
      ...existing.titles,

      ...Object.fromEntries(
        Object.entries(incoming.titles).filter(
          ([key, value]) =>
            key !== "synonyms" &&
            typeof value === "string" &&
            value.trim() !== "",
        ),
      ),

      synonyms: [
        ...new Set([...existing.titles.synonyms, ...incoming.titles.synonyms]),
      ],
    },

    externalIds: {
      ...existing.externalIds,
      ...incoming.externalIds,
    },

    ...(episodes !== undefined ? { episodes } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(ageRating !== undefined ? { ageRating } : {}),
    ...(posterUrl !== undefined ? { posterUrl } : {}),
    ...(averageScore !== undefined ? { averageScore } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(releaseStatus !== undefined ? { releaseStatus } : {}),
  };
}

/**
 * Объединяет две идентичности аниме под ID целевой записи.
 * При конфликте внешних ID объединение запрещается.
 */
function mergeAnimeForReconciliation(
  target: AnimeIdentity,
  source: AnimeIdentity,
): AnimeIdentity {
  for (const [service, sourceId] of Object.entries(source.externalIds)) {
    const targetId =
      target.externalIds[service as keyof typeof target.externalIds];

    if (targetId && sourceId && targetId !== sourceId) {
      throw new Error(
        `External ID conflict for ${service}: ${targetId} vs ${sourceId}`,
      );
    }
  }

  const year = target.year ?? source.year;
  const format = target.format ?? source.format;
  const episodes = target.episodes ?? source.episodes;
  const genres = [...new Set([...(target.genres ?? []), ...(source.genres ?? [])])];
  const ageRating = target.ageRating ?? source.ageRating;
  const posterUrl = target.posterUrl ?? source.posterUrl;
  const averageScore = target.averageScore ?? source.averageScore;
  const startDate = target.startDate ?? source.startDate;
  const releaseStatus = target.releaseStatus ?? source.releaseStatus;

  const english = target.titles.english || source.titles.english;
  const romaji = target.titles.romaji || source.titles.romaji;
  const native = target.titles.native || source.titles.native;

  return {
    id: target.id,

    titles: {
      ...(english !== undefined ? { english } : {}),
      ...(romaji !== undefined ? { romaji } : {}),
      ...(native !== undefined ? { native } : {}),
      synonyms: [
        ...new Set([...target.titles.synonyms, ...source.titles.synonyms]),
      ],
    },

    externalIds: {
      ...source.externalIds,
      ...target.externalIds,
    },

    ...(year !== undefined ? { year } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(episodes !== undefined ? { episodes } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(ageRating !== undefined ? { ageRating } : {}),
    ...(posterUrl !== undefined ? { posterUrl } : {}),
    ...(averageScore !== undefined ? { averageScore } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(releaseStatus !== undefined ? { releaseStatus } : {}),
  };
}

function mergeSourceEntries(
  existing: AnimeSourceEntry[],
  incoming: AnimeSourceEntry[],
): AnimeSourceEntry[] {
  const merged = new Map<string, AnimeSourceEntry>();

  for (const entry of existing) {
    merged.set(`${entry.animeId}:${entry.source}`, structuredClone(entry));
  }

  for (const entry of incoming) {
    const key = `${entry.animeId}:${entry.source}`;
    const previous = merged.get(key);

    if (
      !previous ||
      getTimestamp(entry.updatedAt) >= getTimestamp(previous.updatedAt)
    ) {
      merged.set(key, structuredClone(entry));
    }
  }

  return [...merged.values()];
}

/**
 * Возвращает ключ смысловой связи.
 * ID связи не участвует в сравнении: две связи с разными ID,
 * но одинаковыми концами и типом считаются дубликатами.
 */
function getAnimeRelationKey(relation: AnimeRelation): string {
  return JSON.stringify([
    relation.sourceAnimeId,
    relation.targetAnimeId,
    relation.type,
    relation.seasonNumber ?? null,
    relation.partNumber ?? null,
  ]);
}

/**
 * Объединяет наборы связей.
 *
 * - Смысловые дубликаты объединяются.
 * - При одинаковом ID и разных связях выбрасывается ошибка.
 * - Направление связи сохраняется.
 */
function mergeAnimeRelations(...groups: AnimeRelation[][]): AnimeRelation[] {
  const bySemanticKey = new Map<string, AnimeRelation>();
  const byId = new Map<string, string>();

  for (const group of groups) {
    for (const relation of group) {
      const semanticKey = getAnimeRelationKey(relation);
      const previousSemanticKey = byId.get(relation.id);

      if (
        previousSemanticKey !== undefined &&
        previousSemanticKey !== semanticKey
      ) {
        throw new Error(`Anime relation ID conflict: ${relation.id}`);
      }

      byId.set(relation.id, semanticKey);

      if (!bySemanticKey.has(semanticKey)) {
        bySemanticKey.set(semanticKey, structuredClone(relation));
      }
    }
  }

  return [...bySemanticKey.values()];
}

/**
 * Переназначает ID аниме в обоих концах связей.
 * Связи, превратившиеся в ссылку аниме на само себя,
 * удаляются. Повторяющиеся связи объединяются.
 */
function remapAnimeRelations(
  relations: AnimeRelation[],
  mappings: Record<string, string>,
): AnimeRelation[] {
  const remapped = relations
    .map((relation) => ({
      ...structuredClone(relation),
      sourceAnimeId: mappings[relation.sourceAnimeId] ?? relation.sourceAnimeId,
      targetAnimeId: mappings[relation.targetAnimeId] ?? relation.targetAnimeId,
    }))
    .filter((relation) => relation.sourceAnimeId !== relation.targetAnimeId);

  return mergeAnimeRelations(remapped);
}

/**
 * Оставляет только решения, соответствующие актуальным
 * исходным записям. При наличии нескольких решений
 * выбирает самое позднее.
 */
function mergeConflictResolutions(
  sourceEntries: AnimeSourceEntry[],
  ...resolutionGroups: ConflictResolution[][]
): ConflictResolution[] {
  const entriesByAnimeId = new Map<string, AnimeSourceEntry[]>();

  for (const entry of sourceEntries) {
    const group = entriesByAnimeId.get(entry.animeId) ?? [];
    group.push(entry);
    entriesByAnimeId.set(entry.animeId, group);
  }

  const candidates = new Map<string, ConflictResolution>();

  for (const group of resolutionGroups) {
    for (const resolution of group) {
      const entries = entriesByAnimeId.get(resolution.animeId);

      if (!entries || entries.length === 0) continue;

      if (resolution.fingerprint !== createFingerprint(entries)) {
        continue;
      }

      const previous = candidates.get(resolution.animeId);

      if (
        !previous ||
        getTimestamp(resolution.resolvedAt) >= getTimestamp(previous.resolvedAt)
      ) {
        candidates.set(resolution.animeId, structuredClone(resolution));
      }
    }
  }

  return [...candidates.values()];
}

function buildMergedEntries(
  sourceEntries: AnimeSourceEntry[],
  resolutions: ConflictResolution[] = [],
): AnimeListEntry[] {
  const grouped = new Map<string, AnimeSourceEntry[]>();

  for (const entry of sourceEntries) {
    const group = grouped.get(entry.animeId) ?? [];
    group.push(entry);
    grouped.set(entry.animeId, group);
  }

  const resolutionsByAnimeId = new Map(
    resolutions.map((resolution) => [resolution.animeId, resolution]),
  );

  const result: AnimeListEntry[] = [];

  for (const [animeId, records] of grouped) {
    if (records.length === 0) continue;

    const maxProgress = Math.max(...records.map((entry) => entry.progress));

    const progressRecords = records
      .filter((entry) => entry.progress === maxProgress)
      .sort((a, b) => getTimestamp(b.updatedAt) - getTimestamp(a.updatedAt));

    const statusRecord = progressRecords[0];

    const scoreRecords = records
      .filter((entry) => entry.score !== null)
      .sort((a, b) => getTimestamp(b.updatedAt) - getTimestamp(a.updatedAt));

    const latestRecord = [...records].sort(
      (a, b) => getTimestamp(b.updatedAt) - getTimestamp(a.updatedAt),
    )[0];

    if (!statusRecord || !latestRecord) continue;

    const resolution = resolutionsByAnimeId.get(animeId);

    const resolutionIsCurrent =
      resolution?.fingerprint === createFingerprint(records);

    result.push({
      ...statusRecord,
      animeId,
      progress: maxProgress,
      status: resolutionIsCurrent ? resolution.status : statusRecord.status,
      score: scoreRecords[0]?.score ?? null,
      favorite: records.some((entry) => entry.favorite),
      updatedAt: latestRecord.updatedAt,
      source: statusRecord.source,
    });
  }

  return result;
}

function assertRelationsReferenceExistingAnime(
  relations: AnimeRelation[],
  animeIds: Set<string>,
): void {
  for (const relation of relations) {
    if (!animeIds.has(relation.sourceAnimeId)) {
      throw new Error(
        `Anime relation references missing source anime: ${relation.sourceAnimeId}`,
      );
    }

    if (!animeIds.has(relation.targetAnimeId)) {
      throw new Error(
        `Anime relation references missing target anime: ${relation.targetAnimeId}`,
      );
    }
  }
}

export class BrowserAnimeRepository {
  private constructor(private readonly db: IDBPDatabase<AnimeSyncDB>) {}

  static async open(
    databaseName = "midahoshi-anime-sync",
  ): Promise<BrowserAnimeRepository> {
    const db = await openDB<AnimeSyncDB>(databaseName, 7, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          database.createObjectStore("anime", {
            keyPath: "id",
          });

          database.createObjectStore("entries", {
            keyPath: "animeId",
          });
        }

        if (oldVersion < 2) {
          const sourceEntries = database.createObjectStore("sourceEntries", {
            keyPath: ["animeId", "source"],
          });

          const oldEntries = transaction.objectStore("entries");

          void oldEntries.getAll().then((entries) => {
            for (const entry of entries) {
              sourceEntries.put(structuredClone(entry));
            }
          });
        }

        if (oldVersion < 3) {
          database.createObjectStore("conflictResolutions", {
            keyPath: "animeId",
          });
        }

        if (oldVersion < 4) {
          database.createObjectStore("animeRelations", {
            keyPath: "id",
          });
        }

        if (oldVersion < 5) {
          const operations = database.createObjectStore("syncOperations", {
            keyPath: "id",
          });
          operations.createIndex("by-session", "sessionId");
          operations.createIndex("by-status", "status");
          operations.createIndex("by-provider", "provider");
        }

        if (oldVersion < 6) {
          const sessions = database.createObjectStore("syncSessions", {
            keyPath: "sessionId",
          });
          sessions.createIndex("by-started-at", "startedAt");
          sessions.createIndex("by-provider", "provider");
          sessions.createIndex("by-status", "status");
        }

        if (oldVersion < 7) {
          const deletions = database.createObjectStore("deletionIntents", { keyPath: "id" });
          deletions.createIndex("by-provider", "provider");
          deletions.createIndex("by-created-at", "createdAt");
        }
      },
    });

    return new BrowserAnimeRepository(db);
  }


  /**
   * Persists a complete sync plan before any local or remote writes begin.
   * This is an operation journal, not a distributed transaction.
   */
  async saveSyncOperations(operations: SyncOperation[]): Promise<void> {
    if (operations.length === 0) return;
    const transaction = this.db.transaction("syncOperations", "readwrite");
    const store = transaction.objectStore("syncOperations");
    for (const operation of operations) {
      await store.put(structuredClone(operation));
    }
    await transaction.done;
  }

  async updateSyncOperation(
    id: string,
    changes: Partial<Pick<SyncOperation, "status" | "attempts" | "error">>,
  ): Promise<void> {
    const transaction = this.db.transaction("syncOperations", "readwrite");
    const store = transaction.objectStore("syncOperations");
    const existing = await store.get(id);
    if (!existing) {
      await transaction.done;
      throw new Error(`Unknown sync operation: ${id}`);
    }
    const updated: SyncOperation = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    if (changes.error === undefined && changes.status !== "failed") {
      delete updated.error;
    }
    await store.put(updated);
    await transaction.done;
  }

  async getSyncOperations(): Promise<SyncOperation[]> {
    const operations = await this.db.getAll("syncOperations");
    return operations
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((operation) => structuredClone(operation));
  }

  async saveSyncSession(session: SyncSession): Promise<void> {
    await this.db.put("syncSessions", structuredClone(session));
  }

  async updateSyncSession(
    sessionId: string,
    changes: Partial<Omit<SyncSession, "sessionId" | "provider" | "startedAt">>,
  ): Promise<void> {
    const transaction = this.db.transaction("syncSessions", "readwrite");
    const store = transaction.objectStore("syncSessions");
    const existing = await store.get(sessionId);
    if (!existing) {
      await transaction.done;
      throw new Error(`Unknown sync session: ${sessionId}`);
    }
    await store.put({
      ...existing,
      ...changes,
    });
    await transaction.done;
  }

  async getSyncSessions(): Promise<SyncSession[]> {
    const sessions = await this.db.getAll("syncSessions");
    return sessions
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => structuredClone(session));
  }

  async getUnfinishedSyncOperations(provider?: "mal" | "anilist"): Promise<SyncOperation[]> {
    const operations = await this.getSyncOperations();
    return operations.filter((operation) =>
      operation.status !== "succeeded" &&
      operation.status !== "cancelled" &&
      (provider === undefined || operation.provider === provider),
    );
  }

  /**
   * Atomically creates an anime and its first provider entry.
   * Prevents interrupted syncs from leaving an anime without its list entry.
   */
  async saveAnimeWithEntry(
    anime: AnimeIdentity,
    entry: AnimeSourceEntry,
  ): Promise<void> {
    validateEntry(entry);
    if (anime.id !== entry.animeId) {
      throw new Error("Anime and entry IDs must match");
    }

    const transaction = this.db.transaction(
      ["anime", "entries", "sourceEntries", "conflictResolutions", "deletionIntents"],
      "readwrite",
    );
    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    try {
      const animeStore = transaction.objectStore("anime");
      const entriesStore = transaction.objectStore("entries");
      const sourceStore = transaction.objectStore("sourceEntries");
      const resolutionStore = transaction.objectStore("conflictResolutions");
      const deletionStore = transaction.objectStore("deletionIntents");

      const pendingDeletions = await deletionStore.getAll();
      await Promise.all(pendingDeletions
        .filter((intent) => {
          const service = intent.provider === "mal" ? "myanimelist" : "anilist";
          return anime.externalIds[service] === intent.externalId;
        })
        .map((intent) => deletionStore.delete(intent.id)));

      await animeStore.put(structuredClone(anime));
      await sourceStore.put(structuredClone(entry));

      const sourceEntries = await sourceStore.getAll(
        IDBKeyRange.bound([anime.id, ""], [anime.id, "\uffff"]),
      );
      const resolution = await resolutionStore.get(anime.id);
      const validResolutions = mergeConflictResolutions(
        sourceEntries,
        resolution ? [resolution] : [],
      );
      const mergedEntry = buildMergedEntries(sourceEntries, validResolutions)[0];

      if (mergedEntry) await entriesStore.put(mergedEntry);
      if (resolution && validResolutions.length === 0) {
        await resolutionStore.delete(anime.id);
      }

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  async saveAnime(anime: AnimeIdentity): Promise<void> {
    const transaction = this.db.transaction(["anime", "deletionIntents"], "readwrite");
    const animeStore = transaction.objectStore("anime");
    const deletionStore = transaction.objectStore("deletionIntents");
    const pendingDeletions = await deletionStore.getAll();
    await Promise.all(pendingDeletions
      .filter((intent) => {
        const service = intent.provider === "mal" ? "myanimelist" : "anilist";
        return anime.externalIds[service] === intent.externalId;
      })
      .map((intent) => deletionStore.delete(intent.id)));
    await animeStore.put(structuredClone(anime));
    await transaction.done;
  }

  /**
   * Adds catalog metadata to an existing local anime record.
   * The local ID and all personal watch-list entries remain untouched.
   */
  async updateAnimeMetadata(
    animeId: string,
    metadata: AnimeIdentity,
  ): Promise<void> {
    const transaction = this.db.transaction("anime", "readwrite");
    const store = transaction.objectStore("anime");
    const existing = await store.get(animeId);

    if (!existing) {
      await transaction.done;
      throw new Error(`Unknown animeId: ${animeId}`);
    }

    for (const [service, incomingId] of Object.entries(metadata.externalIds)) {
      const existingId =
        existing.externalIds[service as keyof AnimeIdentity["externalIds"]];
      if (existingId && incomingId && existingId !== incomingId) {
        await transaction.done;
        throw new Error(
          `Catalog metadata ID conflict for ${service}: ${existingId} vs ${incomingId}`,
        );
      }
    }

    const merged = mergeAnimeIdentity(existing, {
      ...structuredClone(metadata),
      id: animeId,
    });

    await store.put(merged);
    await transaction.done;
  }

  async saveEntry(entry: AnimeListEntry): Promise<void> {
    await this.saveSourceEntry(entry);
  }

  async saveSourceEntry(entry: AnimeSourceEntry): Promise<void> {
    await this.saveSourceEntries([entry]);
  }

  /**
   * Atomically stores a batch of provider baselines/source entries and rebuilds
   * the affected aggregate library entries in the same IndexedDB transaction.
   */
  async saveSourceEntries(entries: AnimeSourceEntry[]): Promise<void> {
    for (const entry of entries) validateEntry(entry);
    if (entries.length === 0) return;

    const transaction = this.db.transaction(
      ["anime", "entries", "sourceEntries", "conflictResolutions"],
      "readwrite",
    );
    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    try {
      const animeStore = transaction.objectStore("anime");
      const entriesStore = transaction.objectStore("entries");
      const sourceStore = transaction.objectStore("sourceEntries");
      const resolutionStore = transaction.objectStore("conflictResolutions");
      const affectedAnimeIds = new Set<string>();

      for (const entry of entries) {
        const anime = await animeStore.get(entry.animeId);
        if (!anime) throw new Error(`Unknown animeId: ${entry.animeId}`);

        await sourceStore.put(structuredClone(entry));
        affectedAnimeIds.add(entry.animeId);
      }

      for (const animeId of affectedAnimeIds) {
        const sourceEntries = await sourceStore.getAll(
          IDBKeyRange.bound([animeId, ""], [animeId, "\uffff"]),
        );
        const resolution = await resolutionStore.get(animeId);
        const validResolutions = mergeConflictResolutions(
          sourceEntries,
          resolution ? [resolution] : [],
        );
        const mergedEntry = buildMergedEntries(sourceEntries, validResolutions)[0];

        if (mergedEntry) await entriesStore.put(mergedEntry);
        if (resolution && validResolutions.length === 0) {
          await resolutionStore.delete(animeId);
        }
      }

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  async saveAnimeRelation(relation: AnimeRelation): Promise<void> {
    await this.saveAnimeRelations([relation]);
  }

  /**
   * Сохраняет несколько связей одной транзакцией.
   * Проверяет типы связей и существование обоих аниме.
   */
  async saveAnimeRelations(relations: AnimeRelation[]): Promise<void> {
    const transaction = this.db.transaction(
      ["anime", "animeRelations"],
      "readwrite",
    );

    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    try {
      const anime = await transaction.objectStore("anime").getAll();
      const animeIds = new Set(anime.map((item) => item.id));

      const candidate = validateSnapshot({
        schemaVersion: 4,
        exportedAt: new Date().toISOString(),
        anime,
        entries: [],
        sourceEntries: [],
        conflictResolutions: [],
        animeRelations: relations,
      });

      assertRelationsReferenceExistingAnime(candidate.animeRelations, animeIds);

      const relationStore = transaction.objectStore("animeRelations");
      const existing = await relationStore.getAll();
      const merged = mergeAnimeRelations(existing, candidate.animeRelations);

      assertRelationsReferenceExistingAnime(merged, animeIds);

      await Promise.all([
        relationStore.clear(),
        ...merged.map((relation) =>
          relationStore.put(structuredClone(relation)),
        ),
      ]);

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Транзакция могла уже завершиться или прерваться.
      }

      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Возвращает все связи или только связи, в которых участвует указанное аниме.
   * Учитываются оба конца связи: sourceAnimeId и targetAnimeId.
   */
  async getAnimeRelations(animeId?: string): Promise<AnimeRelation[]> {
    const relations = await this.db.getAll("animeRelations");

    const filtered = animeId
      ? relations.filter(
          (relation) =>
            relation.sourceAnimeId === animeId ||
            relation.targetAnimeId === animeId,
        )
      : relations;

    return filtered.map((relation) => structuredClone(relation));
  }

  async getAnime(id: string): Promise<AnimeIdentity | undefined> {
    const value = await this.db.get("anime", id);
    return value ? structuredClone(value) : undefined;
  }

  async getEntry(animeId: string): Promise<AnimeListEntry | undefined> {
    const value = await this.db.get("entries", animeId);
    return value ? structuredClone(value) : undefined;
  }

  async getSourceEntries(animeId: string): Promise<AnimeSourceEntry[]> {
    const entries = await this.db.getAll(
      "sourceEntries",
      IDBKeyRange.bound([animeId, ""], [animeId, "\uffff"]),
    );

    return entries.map((entry) => structuredClone(entry));
  }

  async getConflicts(animeId?: string): Promise<SyncConflict[]> {
    const entries = animeId
      ? await this.getSourceEntries(animeId)
      : await this.db.getAll("sourceEntries");

    const grouped = new Map<string, AnimeSourceEntry[]>();

    for (const entry of entries) {
      const group = grouped.get(entry.animeId) ?? [];
      group.push(entry);
      grouped.set(entry.animeId, group);
    }

    const resolutions = await this.db.getAll("conflictResolutions");

    const resolutionsByAnimeId = new Map(
      resolutions.map((resolution) => [resolution.animeId, resolution]),
    );

    return [...grouped.entries()].flatMap(([id, group]) => {
      const resolution = resolutionsByAnimeId.get(id);

      if (resolution && resolution.fingerprint === createFingerprint(group)) {
        return [];
      }

      return detectMaxProgressStatusConflicts(group);
    });
  }

  async resolveStatusConflict(
    animeId: string,
    status: AnimeStatus,
  ): Promise<void> {
    const sourceEntries = await this.getSourceEntries(animeId);

    const conflicts = detectMaxProgressStatusConflicts(sourceEntries);

    if (conflicts.length === 0) {
      throw new Error("No status conflict exists for this anime");
    }

    const maxProgress = Math.max(
      ...sourceEntries.map((entry) => entry.progress),
    );

    const availableStatuses = new Set(
      sourceEntries
        .filter((entry) => entry.progress === maxProgress)
        .map((entry) => entry.status),
    );

    if (!availableStatuses.has(status)) {
      throw new Error("Selected status is not one of the conflicting statuses");
    }

    const resolution: ConflictResolution = {
      animeId,
      status,
      fingerprint: createFingerprint(sourceEntries),
      resolvedAt: new Date().toISOString(),
    };

    const transaction = this.db.transaction(
      ["entries", "conflictResolutions"],
      "readwrite",
    );

    await transaction
      .objectStore("conflictResolutions")
      .put(structuredClone(resolution));

    const merged = buildMergedEntries(sourceEntries, [resolution]);

    if (merged[0]) {
      await transaction.objectStore("entries").put(merged[0]);
    }

    await transaction.done;
  }

  async getConflictResolution(
    animeId: string,
  ): Promise<ConflictResolution | undefined> {
    const resolution = await this.db.get("conflictResolutions", animeId);

    return resolution ? structuredClone(resolution) : undefined;
  }

  async getAll(): Promise<
    Array<{
      anime: AnimeIdentity;
      entry: AnimeListEntry | undefined;
    }>
  > {
    const transaction = this.db.transaction(["anime", "entries"], "readonly");

    const [animeList, entriesList] = await Promise.all([
      transaction.objectStore("anime").getAll(),
      transaction.objectStore("entries").getAll(),
    ]);

    await transaction.done;

    const entriesByAnimeId = new Map(
      entriesList.map((entry) => [entry.animeId, entry]),
    );

    return animeList.map((anime) => ({
      anime: structuredClone(anime),
      entry: entriesByAnimeId.has(anime.id)
        ? structuredClone(entriesByAnimeId.get(anime.id)!)
        : undefined,
    }));
  }

  /**
   * Объединяет две записи аниме под ID целевой записи.
   * Исходная запись удаляется, а её источники и связи переносятся
   * в целевую запись.
   */
  async mergeAnimeRecords(sourceId: string, targetId: string): Promise<void> {
    if (sourceId === targetId) {
      throw new Error("Cannot merge an anime record into itself");
    }

    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
      ],
      "readwrite",
    );

    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    const animeStore = transaction.objectStore("anime");
    const entriesStore = transaction.objectStore("entries");
    const sourceStore = transaction.objectStore("sourceEntries");
    const resolutionStore = transaction.objectStore("conflictResolutions");
    const relationStore = transaction.objectStore("animeRelations");

    try {
      const [
        sourceAnime,
        targetAnime,
        allSourceEntries,
        resolutions,
        allRelations,
      ] = await Promise.all([
        animeStore.get(sourceId),
        animeStore.get(targetId),
        sourceStore.getAll(),
        resolutionStore.getAll(),
        relationStore.getAll(),
      ]);

      if (!sourceAnime) {
        throw new Error(`Source anime not found: ${sourceId}`);
      }

      if (!targetAnime) {
        throw new Error(`Target anime not found: ${targetId}`);
      }

      const mergedAnime = mergeAnimeForReconciliation(targetAnime, sourceAnime);

      const affectedEntries = allSourceEntries.filter(
        (entry) => entry.animeId === sourceId || entry.animeId === targetId,
      );

      const remappedEntries = affectedEntries.map((entry) => ({
        ...structuredClone(entry),
        animeId: targetId,
      }));

      const mergedSourceEntries = mergeSourceEntries([], remappedEntries);

      const unaffectedEntries = allSourceEntries.filter(
        (entry) => entry.animeId !== sourceId && entry.animeId !== targetId,
      );

      const allUpdatedSourceEntries = [
        ...unaffectedEntries,
        ...mergedSourceEntries,
      ];

      const affectedResolutions = resolutions
        .filter(
          (resolution) =>
            resolution.animeId === sourceId || resolution.animeId === targetId,
        )
        .map((resolution) => ({
          ...structuredClone(resolution),
          animeId: targetId,
        }));

      const unaffectedResolutions = resolutions.filter(
        (resolution) =>
          resolution.animeId !== sourceId && resolution.animeId !== targetId,
      );

      const mergedResolutions = mergeConflictResolutions(
        mergedSourceEntries,
        affectedResolutions,
      );

      const updatedResolutions = [
        ...unaffectedResolutions,
        ...mergedResolutions,
      ];

      const updatedEntries = buildMergedEntries(
        allUpdatedSourceEntries,
        updatedResolutions,
      );

      const mergedListEntry = updatedEntries.find(
        (entry) => entry.animeId === targetId,
      );

      const remappedRelations = remapAnimeRelations(allRelations, {
        [sourceId]: targetId,
      });

      assertRelationsReferenceExistingAnime(
        remappedRelations,
        new Set([
          ...allUpdatedSourceEntries.map((entry) => entry.animeId),
          ...allUpdatedSourceEntries
            .filter((entry) => entry.animeId !== sourceId)
            .map((entry) => entry.animeId),
          ...allRelations
            .flatMap((relation) => [
              relation.sourceAnimeId,
              relation.targetAnimeId,
            ])
            .filter((id) => id !== sourceId),
          targetId,
          ...allRelations
            .flatMap((relation) => [
              relation.sourceAnimeId,
              relation.targetAnimeId,
            ])
            .filter((id) => id !== sourceId && id !== targetId),
        ]),
      );

      await Promise.all([
        animeStore.delete(sourceId),
        animeStore.put(mergedAnime),

        entriesStore.delete(sourceId),
        entriesStore.delete(targetId),

        resolutionStore.delete(sourceId),
        resolutionStore.delete(targetId),

        ...affectedEntries.map((entry) =>
          sourceStore.delete([entry.animeId, entry.source]),
        ),

        relationStore.clear(),
      ]);

      await Promise.all([
        ...mergedSourceEntries.map((entry) =>
          sourceStore.put(structuredClone(entry)),
        ),

        ...(mergedListEntry
          ? [entriesStore.put(structuredClone(mergedListEntry))]
          : []),

        ...mergedResolutions.map((resolution) =>
          resolutionStore.put(structuredClone(resolution)),
        ),

        ...remappedRelations.map((relation) =>
          relationStore.put(structuredClone(relation)),
        ),
      ]);

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Транзакция могла уже завершиться или прерваться.
      }

      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  async deleteAnime(
    id: string,
    deletionIntents: SyncDeletionIntent[] = [],
  ): Promise<void> {
    if (deletionIntents.some((intent) => intent.animeId !== id)) {
      throw new Error("Deletion intents must belong to the anime being deleted");
    }
    if (deletionIntents.length > 0) {
      validateSnapshot({
        schemaVersion: 4,
        exportedAt: new Date().toISOString(),
        anime: [],
        entries: [],
        sourceEntries: [],
        conflictResolutions: [],
        animeRelations: [],
        deletionIntents,
      });
    }

    const transaction = this.db.transaction(
      ["anime", "entries", "sourceEntries", "conflictResolutions", "animeRelations", "deletionIntents"],
      "readwrite",
    );
    const sourceStore = transaction.objectStore("sourceEntries");
    const relationStore = transaction.objectStore("animeRelations");
    const deletionStore = transaction.objectStore("deletionIntents");
    const [sourceRecords, relations] = await Promise.all([
      sourceStore.getAll(IDBKeyRange.bound([id, ""], [id, "\uffff"])),
      relationStore.getAll(),
    ]);
    const relatedRelations = relations.filter(
      (relation) => relation.sourceAnimeId === id || relation.targetAnimeId === id,
    );
    await Promise.all([
      transaction.objectStore("anime").delete(id),
      transaction.objectStore("entries").delete(id),
      transaction.objectStore("conflictResolutions").delete(id),
      ...sourceRecords.map((entry) => sourceStore.delete([entry.animeId, entry.source])),
      ...relatedRelations.map((relation) => relationStore.delete(relation.id)),
      ...deletionIntents.map((intent) => deletionStore.put(structuredClone(intent))),
    ]);
    await transaction.done;
  }

  async getDeletionIntents(provider?: "mal" | "anilist"): Promise<SyncDeletionIntent[]> {
    const intents = await this.db.getAll("deletionIntents");
    return intents
      .filter((intent) => provider === undefined || intent.provider === provider)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((intent) => structuredClone(intent));
  }

  async deleteDeletionIntent(id: string): Promise<void> {
    await this.db.delete("deletionIntents", id);
  }

  /**
   * Removes only one provider's source entry and rebuilds the aggregate entry.
   * The anime identity and entries from other providers remain untouched.
   */
  async deleteSourceEntry(animeId: string, source: "myanimelist" | "anilist"): Promise<void> {
    const transaction = this.db.transaction(["entries", "sourceEntries", "conflictResolutions"], "readwrite");
    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);
    try {
      const entriesStore = transaction.objectStore("entries");
      const sourceStore = transaction.objectStore("sourceEntries");
      const resolutionStore = transaction.objectStore("conflictResolutions");
      await Promise.all([
        sourceStore.delete([animeId, source]),
        sourceStore.delete([animeId, "local"]),
      ]);
      const remaining = await sourceStore.getAll(
        IDBKeyRange.bound([animeId, ""], [animeId, "\uffff"]),
      );
      const resolution = await resolutionStore.get(animeId);
      const validResolutions = mergeConflictResolutions(remaining, resolution ? [resolution] : []);
      const merged = buildMergedEntries(remaining, validResolutions)[0];
      if (merged) await entriesStore.put(merged);
      else await entriesStore.delete(animeId);
      if (resolution && validResolutions.length === 0) await resolutionStore.delete(animeId);
      await transactionDone;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Создаёт резервную копию V4.
   * Сохраняет исходные записи, решения конфликтов и связи аниме.
   */
  async snapshot(): Promise<AnimeSnapshotV4> {
    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
        "deletionIntents",
      ],
      "readonly",
    );

    const [anime, entries, sourceEntries, storedResolutions, animeRelations, deletionIntents] =
      await Promise.all([
        transaction.objectStore("anime").getAll(),
        transaction.objectStore("entries").getAll(),
        transaction.objectStore("sourceEntries").getAll(),
        transaction.objectStore("conflictResolutions").getAll(),
        transaction.objectStore("animeRelations").getAll(),
        transaction.objectStore("deletionIntents").getAll(),
      ]);

    await transaction.done;

    const conflictResolutions = mergeConflictResolutions(
      sourceEntries,
      storedResolutions,
    );

    return {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      anime: anime.map((item) => structuredClone(item)),
      entries: entries.map((item) => structuredClone(item)),
      sourceEntries: sourceEntries.map((item) => structuredClone(item)),
      conflictResolutions: conflictResolutions.map((item) =>
        structuredClone(item),
      ),
      animeRelations: animeRelations.map((item) => structuredClone(item)),
      deletionIntents: deletionIntents.map((item) => structuredClone(item)),
    };
  }

  /**
   * Объединяет входящую резервную копию с текущей библиотекой.
   * Существующие аниме, записи и связи не удаляются.
   */
  async mergeSnapshot(value: unknown): Promise<void> {
    const incoming = validateSnapshot(value);
    const current = await this.snapshot();

    const animeMap = new Map<string, AnimeIdentity>();

    for (const item of current.anime) {
      animeMap.set(item.id, structuredClone(item));
    }

    for (const item of incoming.anime) {
      const existing = animeMap.get(item.id);

      animeMap.set(
        item.id,
        existing ? mergeAnimeIdentity(existing, item) : structuredClone(item),
      );
    }

    const anime = [...animeMap.values()];

    const sourceEntries = mergeSourceEntries(
      current.sourceEntries,
      incoming.sourceEntries,
    );

    const conflictResolutions = mergeConflictResolutions(
      sourceEntries,
      current.conflictResolutions,
      incoming.conflictResolutions,
    );

    const entries = buildMergedEntries(sourceEntries, conflictResolutions);

    const animeRelations = mergeAnimeRelations(
      current.animeRelations,
      incoming.animeRelations,
    );

    assertRelationsReferenceExistingAnime(
      animeRelations,
      new Set(anime.map((item) => item.id)),
    );

    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
        "deletionIntents",
      ],
      "readwrite",
    );

    const animeStore = transaction.objectStore("anime");
    const entriesStore = transaction.objectStore("entries");
    const sourceEntriesStore = transaction.objectStore("sourceEntries");
    const resolutionStore = transaction.objectStore("conflictResolutions");
    const relationStore = transaction.objectStore("animeRelations");
    const deletionStore = transaction.objectStore("deletionIntents");
    const pendingDeletions = await deletionStore.getAll();
    const intentsToCancel = pendingDeletions.filter((intent) => {
      const service = intent.provider === "mal" ? "myanimelist" : "anilist";
      return anime.some((item) => item.externalIds[service] === intent.externalId);
    });

    const requests = [
      ...intentsToCancel.map((intent) => deletionStore.delete(intent.id)),
      ...anime.map((item) => animeStore.put(structuredClone(item))),
      ...entries.map((item) => entriesStore.put(structuredClone(item))),
      ...sourceEntries.map((item) =>
        sourceEntriesStore.put(structuredClone(item)),
      ),
      ...conflictResolutions.map((item) =>
        resolutionStore.put(structuredClone(item)),
      ),
      ...animeRelations.map((item) => relationStore.put(structuredClone(item))),
    ];

    await Promise.all(requests);
    await transaction.done;
  }

  /**
   * Безопасно объединяет импортированный снимок с текущей библиотекой,
   * учитывая выбранные пользователем соответствия ID.
   *
   * mappings: ID импортируемого аниме -> ID существующего аниме.
   * Все изменения выполняются в одной транзакции.
   */
  async mergeSnapshotWithMappings(
    value: unknown,
    mappings: Record<string, string>,
  ): Promise<void> {
    const incoming = validateSnapshot(value);

    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
      throw new Error("Invalid anime mappings");
    }

    const incomingIds = new Set(incoming.anime.map((anime) => anime.id));
    const mappingEntries = Object.entries(mappings);
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();

    for (const [sourceId, targetId] of mappingEntries) {
      if (
        typeof sourceId !== "string" ||
        typeof targetId !== "string" ||
        !incomingIds.has(sourceId)
      ) {
        throw new Error(`Invalid import mapping: ${sourceId}`);
      }

      if (sourceId === targetId) {
        throw new Error("Unnecessary self mapping");
      }

      if (sourceIds.has(sourceId) || targetIds.has(targetId)) {
        throw new Error("Duplicate anime mapping detected");
      }

      sourceIds.add(sourceId);
      targetIds.add(targetId);
    }

    for (const targetId of targetIds) {
      if (sourceIds.has(targetId)) {
        throw new Error("Chained anime mappings are not allowed");
      }
    }

    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
        "deletionIntents",
      ],
      "readwrite",
    );

    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    const animeStore = transaction.objectStore("anime");
    const entriesStore = transaction.objectStore("entries");
    const sourceStore = transaction.objectStore("sourceEntries");
    const resolutionStore = transaction.objectStore("conflictResolutions");
    const relationStore = transaction.objectStore("animeRelations");
    const deletionStore = transaction.objectStore("deletionIntents");

    try {
      const [
        currentAnime,
        currentEntries,
        currentSourceEntries,
        currentResolutions,
        currentRelations,
        currentDeletionIntents,
      ] = await Promise.all([
        animeStore.getAll(),
        entriesStore.getAll(),
        sourceStore.getAll(),
        resolutionStore.getAll(),
        relationStore.getAll(),
        deletionStore.getAll(),
      ]);

      const currentAnimeMap = new Map(
        currentAnime.map((anime) => [anime.id, anime]),
      );

      for (const [sourceId, targetId] of mappingEntries) {
        if (!currentAnimeMap.has(targetId)) {
          throw new Error(`Mapping target not found: ${targetId}`);
        }

        if (currentAnimeMap.has(sourceId)) {
          throw new Error(`Import ID already exists in library: ${sourceId}`);
        }
      }

      const resolvedIds = new Set<string>();

      for (const anime of incoming.anime) {
        const resolvedId = mappings[anime.id] ?? anime.id;

        if (resolvedIds.has(resolvedId)) {
          throw new Error(
            `Multiple imported anime map to the same ID: ${resolvedId}`,
          );
        }

        resolvedIds.add(resolvedId);
      }

      const animeMap = new Map<string, AnimeIdentity>();

      for (const anime of currentAnime) {
        animeMap.set(anime.id, structuredClone(anime));
      }

      for (const importedAnime of incoming.anime) {
        const targetId = mappings[importedAnime.id] ?? importedAnime.id;
        const existing = animeMap.get(targetId);

        if (existing) {
          animeMap.set(
            targetId,
            mergeAnimeForReconciliation(existing, importedAnime),
          );
        } else {
          animeMap.set(targetId, {
            ...structuredClone(importedAnime),
            id: targetId,
          });
        }
      }

      const currentSourceAnimeIds = new Set(
        currentSourceEntries.map((entry) => entry.animeId),
      );

      const currentFallbackEntries = currentEntries
        .filter((entry) => !currentSourceAnimeIds.has(entry.animeId))
        .map((entry) => structuredClone(entry));

      const incomingSourceAnimeIds = new Set(
        incoming.sourceEntries.map((entry) => entry.animeId),
      );

      const incomingFallbackEntries = incoming.entries
        .filter((entry) => !incomingSourceAnimeIds.has(entry.animeId))
        .map((entry) => structuredClone(entry));

      const remappedIncomingEntries: AnimeSourceEntry[] = [
        ...incoming.sourceEntries,
        ...incomingFallbackEntries,
      ].map((entry) => ({
        ...structuredClone(entry),
        animeId: mappings[entry.animeId] ?? entry.animeId,
      }));

      const allCurrentSourceEntries: AnimeSourceEntry[] = [
        ...currentSourceEntries.map((entry) => structuredClone(entry)),
        ...currentFallbackEntries,
      ];

      const mergedSourceEntries = mergeSourceEntries(
        allCurrentSourceEntries,
        remappedIncomingEntries,
      );

      const remappedIncomingResolutions = incoming.conflictResolutions.map(
        (resolution) => ({
          ...structuredClone(resolution),
          animeId: mappings[resolution.animeId] ?? resolution.animeId,
        }),
      );

      const mergedResolutions = mergeConflictResolutions(
        mergedSourceEntries,
        currentResolutions,
        remappedIncomingResolutions,
      );

      const mergedEntries = buildMergedEntries(
        mergedSourceEntries,
        mergedResolutions,
      );

      for (const entry of mergedSourceEntries) {
        if (!animeMap.has(entry.animeId)) {
          throw new Error(
            `Source entry references missing anime: ${entry.animeId}`,
          );
        }
      }

      const remappedIncomingRelations = remapAnimeRelations(
        incoming.animeRelations,
        mappings,
      );

      const mergedRelations = mergeAnimeRelations(
        currentRelations,
        remappedIncomingRelations,
      );

      assertRelationsReferenceExistingAnime(
        mergedRelations,
        new Set(animeMap.keys()),
      );

      const mergedAnime = [...animeMap.values()];
      const deletionIntentsToCancel = currentDeletionIntents.filter((intent) => {
        const service = intent.provider === "mal" ? "myanimelist" : "anilist";
        return mergedAnime.some((item) => item.externalIds[service] === intent.externalId);
      });

      await Promise.all([
        entriesStore.clear(),
        resolutionStore.clear(),
        relationStore.clear(),
        ...deletionIntentsToCancel.map((intent) => deletionStore.delete(intent.id)),

        ...[...animeMap.values()].map((anime) =>
          animeStore.put(structuredClone(anime)),
        ),

        ...mergedSourceEntries.map((entry) =>
          sourceStore.put(structuredClone(entry)),
        ),

        ...mergedEntries.map((entry) =>
          entriesStore.put(structuredClone(entry)),
        ),

        ...mergedResolutions.map((resolution) =>
          resolutionStore.put(structuredClone(resolution)),
        ),

        ...mergedRelations.map((relation) =>
          relationStore.put(structuredClone(relation)),
        ),
      ]);

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Транзакция могла уже завершиться или прерваться.
      }

      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Полностью восстанавливает библиотеку из резервной копии.
   * В отличие от mergeSnapshot, заменяет существующие данные.
   */
  async importSnapshot(value: unknown): Promise<void> {
    const snapshot = validateSnapshot(value);

    const conflictResolutions = mergeConflictResolutions(
      snapshot.sourceEntries,
      snapshot.conflictResolutions,
    );

    const entries = buildMergedEntries(
      snapshot.sourceEntries,
      conflictResolutions,
    );

    assertRelationsReferenceExistingAnime(
      snapshot.animeRelations,
      new Set(snapshot.anime.map((anime) => anime.id)),
    );

    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
        "deletionIntents",
      ],
      "readwrite",
    );

    const animeStore = transaction.objectStore("anime");
    const entriesStore = transaction.objectStore("entries");
    const sourceEntriesStore = transaction.objectStore("sourceEntries");
    const resolutionStore = transaction.objectStore("conflictResolutions");
    const relationStore = transaction.objectStore("animeRelations");
    const deletionIntentsStore = transaction.objectStore("deletionIntents");

    const requests = [
      animeStore.clear(),
      entriesStore.clear(),
      sourceEntriesStore.clear(),
      resolutionStore.clear(),
      relationStore.clear(),
      deletionIntentsStore.clear(),

      ...snapshot.anime.map((item) => animeStore.put(structuredClone(item))),
      ...entries.map((item) => entriesStore.put(structuredClone(item))),
      ...snapshot.sourceEntries.map((item) =>
        sourceEntriesStore.put(structuredClone(item)),
      ),
      ...conflictResolutions.map((item) =>
        resolutionStore.put(structuredClone(item)),
      ),
      ...snapshot.animeRelations.map((item) =>
        relationStore.put(structuredClone(item)),
      ),
      ...(snapshot.deletionIntents ?? []).map((item) =>
        deletionIntentsStore.put(structuredClone(item)),
      ),
    ];

    await Promise.all(requests);
    await transaction.done;
  }

  /**
   * Полностью восстанавливает библиотеку и одновременно обезвреживает
   * незавершённые операции синхронизации. История завершённых операций
   * и прошлых сессий сохраняется.
   *
   * Все изменения выполняются одной IndexedDB-транзакцией: либо применится
   * весь снимок вместе с обновлением журнала, либо не изменится ничего.
   */
  async restoreSnapshot(value: unknown): Promise<void> {
    const snapshot = validateSnapshot(value);
    const conflictResolutions = mergeConflictResolutions(
      snapshot.sourceEntries,
      snapshot.conflictResolutions,
    );
    const entries = buildMergedEntries(snapshot.sourceEntries, conflictResolutions);

    assertRelationsReferenceExistingAnime(
      snapshot.animeRelations,
      new Set(snapshot.anime.map((anime) => anime.id)),
    );

    const transaction = this.db.transaction(
      [
        "anime",
        "entries",
        "sourceEntries",
        "conflictResolutions",
        "animeRelations",
        "syncOperations",
        "syncSessions",
        "deletionIntents",
      ],
      "readwrite",
    );
    const transactionDone = transaction.done;
    void transactionDone.catch(() => undefined);

    try {
      const animeStore = transaction.objectStore("anime");
      const entriesStore = transaction.objectStore("entries");
      const sourceEntriesStore = transaction.objectStore("sourceEntries");
      const resolutionStore = transaction.objectStore("conflictResolutions");
      const relationStore = transaction.objectStore("animeRelations");
      const operationsStore = transaction.objectStore("syncOperations");
      const sessionsStore = transaction.objectStore("syncSessions");
      const deletionIntentsStore = transaction.objectStore("deletionIntents");

      const [operations, sessions] = await Promise.all([
        operationsStore.getAll(),
        sessionsStore.getAll(),
      ]);

      const restoredAt = new Date().toISOString();
      const interruptedSessionIds = new Set<string>();

      const updatedOperations = operations.map((operation) => {
        if (operation.status !== "pending" && operation.status !== "in_progress") {
          return operation;
        }

        interruptedSessionIds.add(operation.sessionId);
        return {
          ...operation,
          status: "cancelled" as const,
          error: "Операция прервана восстановлением резервной копии. Запусти новую синхронизацию.",
          updatedAt: restoredAt,
        };
      });

      const updatedSessions = sessions.map((session) => {
        if (!interruptedSessionIds.has(session.sessionId)) return session;

        const sessionOperations = updatedOperations.filter(
          (operation) => operation.sessionId === session.sessionId,
        );
        const failedCount = sessionOperations.filter(
          (operation) => operation.status === "failed",
        ).length;

        return {
          ...session,
          status: "cancelled" as const,
          finishedAt: restoredAt,
          operationCount: sessionOperations.length,
          succeededCount: sessionOperations.filter(
            (operation) => operation.status === "succeeded",
          ).length,
          failedCount,
          pendingCount: 0,
          error: "Сессия прервана восстановлением резервной копии.",
        };
      });

      await Promise.all([
        animeStore.clear(),
        entriesStore.clear(),
        sourceEntriesStore.clear(),
        resolutionStore.clear(),
        relationStore.clear(),
        deletionIntentsStore.clear(),
      ]);

      await Promise.all([
        ...snapshot.anime.map((item) => animeStore.put(structuredClone(item))),
        ...entries.map((item) => entriesStore.put(structuredClone(item))),
        ...snapshot.sourceEntries.map((item) =>
          sourceEntriesStore.put(structuredClone(item)),
        ),
        ...conflictResolutions.map((item) =>
          resolutionStore.put(structuredClone(item)),
        ),
        ...snapshot.animeRelations.map((item) =>
          relationStore.put(structuredClone(item)),
        ),
        ...(snapshot.deletionIntents ?? []).map((item) =>
          deletionIntentsStore.put(structuredClone(item)),
        ),
        ...updatedOperations
          .filter((operation, index) => operation !== operations[index])
          .map((operation) => operationsStore.put(operation)),
        ...updatedSessions
          .filter((session, index) => session !== sessions[index])
          .map((session) => sessionsStore.put(session)),
      ]);

      await transactionDone;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Транзакция могла уже завершиться или прерваться.
      }
      await transactionDone.catch(() => undefined);
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
