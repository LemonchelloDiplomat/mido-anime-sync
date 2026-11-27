import type { AnimeListEntry, AnimeStatus } from "./types.js";

export type LocalLibraryChangeField =
  | "status"
  | "progress"
  | "score"
  | "favorite"
  | "startedAt"
  | "completedAt"
  | "rewatchCount";

export type LocalLibraryChangeValue = string | number | boolean | null;

export interface LocalLibraryFieldChange {
  field: LocalLibraryChangeField;
  before: LocalLibraryChangeValue;
  after: LocalLibraryChangeValue;
  total?: number;
}

const statusLabels: Record<AnimeStatus, string> = {
  PLANNING: "В планах",
  WATCHING: "Смотрю",
  COMPLETED: "Просмотрено",
  ON_HOLD: "Отложено",
  DROPPED: "Брошено",
  REWATCHING: "Пересматриваю",
};

function valueOf(entry: AnimeListEntry | undefined, field: LocalLibraryChangeField): LocalLibraryChangeValue {
  if (!entry) return null;
  switch (field) {
    case "status": return entry.status;
    case "progress": return entry.progress;
    case "score": return entry.score;
    case "favorite": return entry.favorite;
    case "startedAt": return entry.sharedMetadata?.startedAt ?? null;
    case "completedAt": return entry.sharedMetadata?.completedAt ?? null;
    case "rewatchCount": return entry.sharedMetadata?.rewatchCount ?? null;
  }
}

const fields: LocalLibraryChangeField[] = [
  "status",
  "progress",
  "score",
  "favorite",
  "startedAt",
  "completedAt",
  "rewatchCount",
];

export function createLocalLibraryFieldChanges(
  previous: AnimeListEntry | undefined,
  next: AnimeListEntry | undefined,
  totalEpisodes?: number | null,
): LocalLibraryFieldChange[] {
  return fields.flatMap((field) => {
    const before = valueOf(previous, field);
    const after = valueOf(next, field);
    if (Object.is(before, after)) return [];
    return [{
      field,
      before,
      after,
      ...(field === "progress" && typeof totalEpisodes === "number" && totalEpisodes > 0
        ? { total: totalEpisodes }
        : {}),
    }];
  });
}

function displayValue(field: LocalLibraryChangeField, value: LocalLibraryChangeValue, total?: number): string {
  if (value === null) return "Нет";
  if (field === "status" && typeof value === "string" && value in statusLabels) {
    return statusLabels[value as AnimeStatus];
  }
  if (field === "favorite" && typeof value === "boolean") return value ? "Да" : "Нет";
  if ((field === "startedAt" || field === "completedAt") && typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ru-RU");
  }
  if (field === "score" && typeof value === "number") return String(value / 10);
  if (field === "progress" && typeof value === "number" && total) return `${value}/${total}`;
  return String(value);
}

const fieldLabels: Record<LocalLibraryChangeField, string> = {
  status: "Статус",
  progress: "Прогресс",
  score: "Оценка",
  favorite: "Избранное",
  startedAt: "Начало просмотра",
  completedAt: "Завершение просмотра",
  rewatchCount: "Количество пересмотров",
};

export function formatLocalLibraryFieldChange(change: LocalLibraryFieldChange): string {
  return `${fieldLabels[change.field]}: ${displayValue(change.field, change.before, change.total)} → ${displayValue(change.field, change.after, change.total)}`;
}
