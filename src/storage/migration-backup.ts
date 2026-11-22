import { openDB, type DBSchema } from "idb";

export const MIGRATION_BACKUP_FORMAT = "midahoshi-indexeddb-migration-backup" as const;
export const MIGRATION_BACKUP_FORMAT_VERSION = 1;
export const MIGRATION_BACKUP_RETENTION = 3;

export interface MigrationBackupStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: Array<{
    name: string;
    keyPath: string | string[];
    unique: boolean;
    multiEntry: boolean;
  }>;
  records: unknown[];
  recordCount: number;
  checksum: string;
}

export interface MigrationBackup {
  id: string;
  format: typeof MIGRATION_BACKUP_FORMAT;
  formatVersion: number;
  sourceDatabaseName: string;
  sourceVersion: number;
  targetVersion: number;
  createdAt: string;
  stores: MigrationBackupStore[];
  integrity: {
    storeCount: number;
    totalRecordCount: number;
  };
}

interface MigrationBackupDB extends DBSchema {
  backups: {
    key: string;
    value: MigrationBackup;
  };
}

function normalizeForChecksum(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalizeForChecksum);
  if (value && typeof value === "object") {
    if (value instanceof ArrayBuffer) {
      return { $arrayBuffer: Array.from(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        $typedArray: value.constructor.name,
        values: Array.from(value as unknown as ArrayLike<number>),
      };
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalizeForChecksum(nested)]),
    );
  }
  return value;
}

function createStoreChecksum(records: unknown[]): string {
  const serialized = JSON.stringify(normalizeForChecksum(records)) ?? "undefined";
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let abortedBecauseMissing = false;

    request.onupgradeneeded = () => {
      // Abort the implicit version-1 creation. A probe must never create or
      // mutate the user's database merely to discover whether it exists.
      abortedBecauseMissing = true;
      request.transaction?.abort();
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      if (abortedBecauseMissing && request.error?.name === "AbortError") {
        resolve(null);
        return;
      }
      reject(request.error ?? new Error("Не удалось открыть локальную базу для резервного копирования."));
    };
  });
}

function readAllStores(database: IDBDatabase): Promise<MigrationBackupStore[]> {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, "readonly");
    const stores: MigrationBackupStore[] = [];
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Не удалось прочитать данные для резервной копии."));
    };

    transaction.onabort = () => fail(transaction.error ?? new Error("Чтение базы было прервано."));
    transaction.onerror = () => fail(transaction.error ?? new Error("Ошибка чтения базы."));

    for (const name of names) {
      const request = transaction.objectStore(name).getAll();
      request.onerror = () => fail(request.error ?? new Error(`Не удалось прочитать хранилище ${name}.`));
      request.onsuccess = () => {
        const sourceStore = transaction.objectStore(name);
        const records = request.result.map((record) => structuredClone(record));
        stores.push({
          name,
          keyPath: Array.isArray(sourceStore.keyPath)
            ? [...sourceStore.keyPath]
            : sourceStore.keyPath,
          autoIncrement: sourceStore.autoIncrement,
          indexes: Array.from(sourceStore.indexNames).map((indexName) => {
            const index = sourceStore.index(indexName);
            return {
              name: index.name,
              keyPath: Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            };
          }),
          records,
          recordCount: records.length,
          checksum: createStoreChecksum(records),
        });
      };
    }

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      stores.sort((a, b) => a.name.localeCompare(b.name));
      resolve(stores);
    };
  });
}

function validateBackup(backup: MigrationBackup): void {
  if (
    backup.format !== MIGRATION_BACKUP_FORMAT ||
    backup.formatVersion !== MIGRATION_BACKUP_FORMAT_VERSION ||
    !backup.sourceDatabaseName ||
    !Number.isInteger(backup.sourceVersion) ||
    !Number.isInteger(backup.targetVersion) ||
    !Array.isArray(backup.stores) ||
    backup.integrity.storeCount !== backup.stores.length
  ) {
    throw new Error("Резервная копия миграции имеет неверный формат.");
  }

  const names = new Set<string>();
  let total = 0;
  for (const store of backup.stores) {
    if (
      !store ||
      typeof store.name !== "string" ||
      names.has(store.name) ||
      !Array.isArray(store.records) ||
      store.recordCount !== store.records.length ||
      typeof store.checksum !== "string" ||
      store.checksum !== createStoreChecksum(store.records) ||
      typeof store.autoIncrement !== "boolean" ||
      !Array.isArray(store.indexes)
    ) {
      throw new Error("Резервная копия содержит повреждённое хранилище.");
    }
    names.add(store.name);
    total += store.records.length;
  }
  if (backup.integrity.totalRecordCount !== total) {
    throw new Error("Контроль количества записей резервной копии не пройден.");
  }
}

export function getMigrationBackupDatabaseName(databaseName: string): string {
  return `${databaseName}__migration_backups`;
}

export async function listMigrationBackups(databaseName: string): Promise<MigrationBackup[]> {
  const backupDb = await openExistingDatabase(getMigrationBackupDatabaseName(databaseName));
  if (!backupDb) return [];

  try {
    if (!backupDb.objectStoreNames.contains("backups")) return [];
    const transaction = backupDb.transaction("backups", "readonly");
    const request = transaction.objectStore("backups").getAll();
    const backups = await new Promise<MigrationBackup[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as MigrationBackup[]);
      request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать список резервных копий."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Чтение резервных копий прервано."));
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Чтение резервных копий прервано."));
    });
    for (const backup of backups) validateBackup(backup);
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    backupDb.close();
  }
}

export async function getLatestMigrationBackup(databaseName: string): Promise<MigrationBackup | null> {
  return (await listMigrationBackups(databaseName))[0] ?? null;
}

/**
 * Restores a selected internal backup atomically. The current database is
 * backed up first. Stores absent from an older backup are left untouched,
 * while incompatible or missing stores abort before any write.
 */
export async function restoreMigrationBackup(
  databaseName: string,
  backupId: string,
): Promise<{ backup: MigrationBackup; safetyBackupId: string; restoredRecordCount: number }> {
  const candidates = await listMigrationBackups(databaseName);
  const backup = candidates.find((item) => item.id === backupId);
  if (!backup) throw new Error("Выбранная автоматическая резервная копия не найдена.");
  validateBackup(backup);

  const initial = await openExistingDatabase(databaseName);
  if (!initial) throw new Error("Основная локальная база не найдена.");
  const currentVersion = initial.version;
  initial.close();

  if (backup.sourceVersion > currentVersion) {
    throw new Error("Эта резервная копия создана для более новой версии базы и не может быть восстановлена в текущую.");
  }

  const safetyBackup = await createMigrationBackupIfNeeded(databaseName, currentVersion + 1);
  if (!safetyBackup) throw new Error("Не удалось создать защитную копию текущей библиотеки. Восстановление отменено.");

  const database = await openExistingDatabase(databaseName);
  if (!database) throw new Error("Основная локальная база недоступна.");
  try {
    if (database.version !== currentVersion) {
      throw new Error("Версия локальной базы изменилась во время подготовки восстановления. Повтори попытку.");
    }

    const currentStoreNames = new Set(Array.from(database.objectStoreNames));
    for (const store of backup.stores) {
      if (!currentStoreNames.has(store.name)) {
        throw new Error(`Хранилище ${store.name} отсутствует в текущей версии приложения. Данные не изменены.`);
      }
      const currentStore = database.transaction(store.name, "readonly").objectStore(store.name);
      if (
        JSON.stringify(currentStore.keyPath) !== JSON.stringify(store.keyPath) ||
        currentStore.autoIncrement !== store.autoIncrement
      ) {
        throw new Error(`Структура хранилища ${store.name} изменилась. Автоматическое восстановление небезопасно, данные не изменены.`);
      }
    }

    const names = backup.stores.map((store) => store.name);
    if (names.length === 0) throw new Error("Резервная копия не содержит хранилищ.");

    const restoredStores = backup.stores.map((store) => ({
      name: store.name,
      records: store.records.map((record) => structuredClone(record)) as Array<Record<string, unknown>>,
    }));

    const operations = restoredStores.find((store) => store.name === "syncOperations");
    const sessions = restoredStores.find((store) => store.name === "syncSessions");
    const interruptedSessionIds = new Set<string>();
    const restoredAt = new Date().toISOString();

    if (operations) {
      operations.records = operations.records.map((operation) => {
        if (operation.status !== "pending" && operation.status !== "in_progress") return operation;
        if (typeof operation.sessionId === "string") interruptedSessionIds.add(operation.sessionId);
        return {
          ...operation,
          status: "cancelled",
          error: "Операция прервана восстановлением автоматической резервной копии. Запусти новую синхронизацию.",
          updatedAt: restoredAt,
        };
      });
    }

    if (sessions && interruptedSessionIds.size > 0) {
      const operationRecords = operations?.records ?? [];
      sessions.records = sessions.records.map((session) => {
        if (typeof session.sessionId !== "string" || !interruptedSessionIds.has(session.sessionId)) return session;
        const sessionOperations = operationRecords.filter((operation) => operation.sessionId === session.sessionId);
        return {
          ...session,
          status: "cancelled",
          finishedAt: restoredAt,
          operationCount: sessionOperations.length,
          succeededCount: sessionOperations.filter((operation) => operation.status === "succeeded").length,
          failedCount: sessionOperations.filter((operation) => operation.status === "failed").length,
          pendingCount: 0,
          error: "Сессия прервана восстановлением автоматической резервной копии.",
        };
      });
    }

    const metadata = restoredStores.find((store) => store.name === "appMetadata");
    if (metadata) {
      metadata.records = metadata.records.map((record) =>
        record.key === "schemaVersion"
          ? { ...record, value: currentVersion, updatedAt: restoredAt }
          : record,
      );
    }

    const transaction = database.transaction(names, "readwrite");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Восстановление отменено: транзакция прервана."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Ошибка транзакции восстановления."));
      try {
        for (const store of restoredStores) {
          const objectStore = transaction.objectStore(store.name);
          objectStore.clear();
          for (const record of store.records) objectStore.put(record);
        }
      } catch (error) {
        try { transaction.abort(); } catch {}
        reject(error instanceof Error ? error : new Error("Не удалось записать данные резервной копии."));
      }
    });

    return {
      backup,
      safetyBackupId: safetyBackup.id,
      restoredRecordCount: restoredStores.reduce((sum, store) => sum + store.records.length, 0),
    };
  } finally {
    database.close();
  }
}

/**
 * Captures every object store before an IndexedDB schema upgrade.
 * If the backup cannot be committed and read back, the caller must not
 * continue with the schema upgrade.
 */
export async function createMigrationBackupIfNeeded(
  databaseName: string,
  targetVersion: number,
): Promise<MigrationBackup | null> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB недоступна. Обновление локальной библиотеки остановлено для защиты данных.");
  }

  const source = await openExistingDatabase(databaseName);
  if (!source) return null;

  let stores: MigrationBackupStore[];
  let sourceVersion: number;
  try {
    sourceVersion = source.version;
    if (sourceVersion >= targetVersion) return null;
    stores = await readAllStores(source);
  } finally {
    source.close();
  }

  const totalRecordCount = stores.reduce((sum, store) => sum + store.recordCount, 0);
  const createdAt = new Date().toISOString();
  const backup: MigrationBackup = {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 10)}`,
    format: MIGRATION_BACKUP_FORMAT,
    formatVersion: MIGRATION_BACKUP_FORMAT_VERSION,
    sourceDatabaseName: databaseName,
    sourceVersion,
    targetVersion,
    createdAt,
    stores,
    integrity: {
      storeCount: stores.length,
      totalRecordCount,
    },
  };
  validateBackup(backup);

  const backupDbName = getMigrationBackupDatabaseName(databaseName);
  if (backupDbName === databaseName) {
    throw new Error("Имя базы резервных копий совпадает с основной базой.");
  }

  const backupDb = await openDB<MigrationBackupDB>(backupDbName, 1, {
    upgrade(database) {
      database.createObjectStore("backups", { keyPath: "id" });
    },
  });

  try {
    await backupDb.put("backups", structuredClone(backup));
    const persisted = await backupDb.get("backups", backup.id);
    if (!persisted) {
      throw new Error("Резервная копия не найдена после сохранения.");
    }
    validateBackup(persisted);
    if (
      persisted.integrity.totalRecordCount !== totalRecordCount ||
      persisted.stores.some((store, index) =>
        store.name !== stores[index]?.name ||
        store.recordCount !== stores[index]?.recordCount
      )
    ) {
      throw new Error("Проверка сохранённой резервной копии не пройдена.");
    }

    const allBackups = (await backupDb.getAll("backups"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const stale of allBackups.slice(MIGRATION_BACKUP_RETENTION)) {
      await backupDb.delete("backups", stale.id);
    }
  } finally {
    backupDb.close();
  }

  return backup;
}
