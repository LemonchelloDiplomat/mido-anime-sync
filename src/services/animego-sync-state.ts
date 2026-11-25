import { openDB, type IDBPDatabase } from "idb";
import type { AnimeStatus } from "../core/types.js";

export type AnimeGoSyncField = "status" | "progress" | "score";
export type AnimeGoConflictChoice = "local" | "remote";

export interface AnimeGoSyncValues {
  status: AnimeStatus;
  progress: number;
  score: number | null;
}

export interface AnimeGoSyncBaseline extends AnimeGoSyncValues {
  externalId: string;
  updatedAt: string;
}

export interface AnimeGoSyncConflict {
  id: string;
  externalId: string;
  animeId: string;
  title: string;
  titleUrl: string;
  field: AnimeGoSyncField;
  baselineValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  detectedAt: string;
}

interface StateSchema {
  baselines: { key: string; value: AnimeGoSyncBaseline };
  conflicts: { key: string; value: AnimeGoSyncConflict };
}

const DB_NAME = "mido-anime-sync-animego-state";
const DB_VERSION = 1;
let dbPromise: Promise<IDBPDatabase<StateSchema>> | null = null;

function database(): Promise<IDBPDatabase<StateSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<StateSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("baselines")) db.createObjectStore("baselines", { keyPath: "externalId" });
        if (!db.objectStoreNames.contains("conflicts")) db.createObjectStore("conflicts", { keyPath: "id" });
      },
      blocked() { dbPromise = null; },
      terminated() { dbPromise = null; },
    });
  }
  return dbPromise;
}

export async function getAnimeGoBaseline(externalId: string): Promise<AnimeGoSyncBaseline | undefined> {
  const value = await (await database()).get("baselines", externalId);
  return value ? structuredClone(value) : undefined;
}

export async function saveAnimeGoBaseline(value: AnimeGoSyncBaseline): Promise<void> {
  await (await database()).put("baselines", structuredClone(value));
}

export async function listAnimeGoConflicts(): Promise<AnimeGoSyncConflict[]> {
  return (await database()).getAll("conflicts");
}

export async function saveAnimeGoConflict(value: AnimeGoSyncConflict): Promise<void> {
  await (await database()).put("conflicts", structuredClone(value));
}

export async function resolveAnimeGoConflict(
  conflictId: string,
  choice: AnimeGoConflictChoice,
): Promise<AnimeGoSyncConflict> {
  const db = await database();
  const tx = db.transaction(["conflicts", "baselines"], "readwrite");
  const conflict = await tx.objectStore("conflicts").get(conflictId);
  if (!conflict) {
    await tx.done;
    throw new Error("Конфликт AnimeGO уже разрешён или больше не существует.");
  }
  const baseline = await tx.objectStore("baselines").get(conflict.externalId);
  if (!baseline) {
    await tx.done;
    throw new Error("Не найдено базовое состояние синхронизации. Повтори получение списка AnimeGO.");
  }
  const value = choice === "local" ? conflict.localValue : conflict.remoteValue;
  const updated = { ...baseline, [conflict.field]: value, updatedAt: new Date().toISOString() };
  await Promise.all([
    tx.objectStore("baselines").put(updated),
    tx.objectStore("conflicts").delete(conflictId),
  ]);
  await tx.done;
  return structuredClone(conflict);
}

export function sameAnimeGoValue(field: AnimeGoSyncField, left: unknown, right: unknown): boolean {
  if (field === "score") {
    const normalize = (value: unknown) => value == null || value === 0 ? null : Math.max(10, Math.min(100, Math.round(Number(value) / 10) * 10));
    return normalize(left) === normalize(right);
  }
  return left === right;
}

export interface AnimeGoReconcileResult {
  values: AnimeGoSyncValues;
  outbound: AnimeGoSyncField[];
  conflicts: AnimeGoSyncConflict[];
  baseline: AnimeGoSyncBaseline;
}

export async function reconcileAnimeGoEntry(input: {
  externalId: string;
  animeId: string;
  title: string;
  titleUrl: string;
  local: AnimeGoSyncValues | null;
  remote: AnimeGoSyncValues;
  updatedAt: string;
}): Promise<AnimeGoReconcileResult> {
  const previous = await getAnimeGoBaseline(input.externalId);
  const values: AnimeGoSyncValues = { ...input.remote };
  const outbound: AnimeGoSyncField[] = [];
  const conflicts: AnimeGoSyncConflict[] = [];
  const now = new Date().toISOString();

  if (!previous && input.local) {
    const baseline: AnimeGoSyncBaseline = {
      externalId: input.externalId,
      ...input.remote,
      updatedAt: input.updatedAt || now,
    };
    for (const field of ["status", "progress", "score"] as const) {
      if (sameAnimeGoValue(field, input.local[field], input.remote[field])) continue;
      conflicts.push({
        id: input.externalId + ":" + field,
        externalId: input.externalId,
        animeId: input.animeId,
        title: input.title,
        titleUrl: input.titleUrl,
        field,
        baselineValue: undefined,
        localValue: input.local[field],
        remoteValue: input.remote[field],
        detectedAt: now,
      });
      values[field] = input.local[field] as never;
      await saveAnimeGoConflict(conflicts[conflicts.length - 1]!);
    }
    await saveAnimeGoBaseline(baseline);
    return { values, outbound, conflicts, baseline };
  }

  if (!previous || !input.local) {
    const baseline = { externalId: input.externalId, ...input.remote, updatedAt: input.updatedAt || now };
    await saveAnimeGoBaseline(baseline);
    return { values, outbound, conflicts, baseline };
  }

  const baseline = { ...previous };
  for (const field of ["status", "progress", "score"] as const) {
    const localValue = input.local[field];
    const remoteValue = input.remote[field];
    const baseValue = previous[field];
    const localChanged = !sameAnimeGoValue(field, localValue, baseValue);
    const remoteChanged = !sameAnimeGoValue(field, remoteValue, baseValue);

    if (localChanged && remoteChanged && !sameAnimeGoValue(field, localValue, remoteValue)) {
      const conflict: AnimeGoSyncConflict = {
        id: input.externalId + ":" + field,
        externalId: input.externalId,
        animeId: input.animeId,
        title: input.title,
        titleUrl: input.titleUrl,
        field,
        baselineValue: baseValue,
        localValue,
        remoteValue,
        detectedAt: now,
      };
      conflicts.push(conflict);
      values[field] = localValue as never;
      await saveAnimeGoConflict(conflict);
      continue;
    }

    if (localChanged && !remoteChanged) {
      values[field] = localValue as never;
      outbound.push(field);
      continue;
    }

    baseline[field] = remoteValue as never;
    values[field] = remoteValue as never;
  }

  baseline.updatedAt = input.updatedAt || now;
  await saveAnimeGoBaseline(baseline);
  return { values, outbound, conflicts, baseline };
}

export async function commitAnimeGoWrite(
  externalId: string,
  field: AnimeGoSyncField,
  value: unknown,
): Promise<void> {
  const current = await getAnimeGoBaseline(externalId);
  if (!current) return;
  await saveAnimeGoBaseline({
    ...current,
    [field]: value,
    updatedAt: new Date().toISOString(),
  });
}
