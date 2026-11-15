import type { AnimeStatus, ServiceId } from "./types.js";

const STATUS_MAP: Record<ServiceId, Record<string, AnimeStatus>> = {
  myanimelist: {
    watching: "WATCHING", completed: "COMPLETED", on_hold: "ON_HOLD",
    dropped: "DROPPED", plan_to_watch: "PLANNING", rewatching: "REWATCHING"
  },
  anilist: {
    CURRENT: "WATCHING", COMPLETED: "COMPLETED", PAUSED: "ON_HOLD",
    DROPPED: "DROPPED", PLANNING: "PLANNING", REPEATING: "REWATCHING"
  },
  shikimori: {
    watching: "WATCHING", completed: "COMPLETED", on_hold: "ON_HOLD",
    dropped: "DROPPED", planned: "PLANNING", rewatching: "REWATCHING"
  },
  anixart: {},
  animego: {},
  yummyanime: {}
};

export function normalizeStatus(service: ServiceId, value: string): AnimeStatus | null {
  return STATUS_MAP[service][value] ?? null;
}

export function normalizeScore(score: number | null, sourceMax: number): number | null {
  if (score === null) return null;
  if (!Number.isFinite(score) || score < 0 || sourceMax <= 0) {
    throw new Error("Invalid score or source scale");
  }
  return Math.max(0, Math.min(100, Math.round((score / sourceMax) * 100)));
}

export function denormalizeScore(score: number | null, targetMax: number): number | null {
  if (score === null) return null;
  if (!Number.isFinite(score) || score < 0 || targetMax <= 0) {
    throw new Error("Invalid score or target scale");
  }
  return Math.max(0, Math.min(targetMax, Math.round((score / 100) * targetMax)));
}
