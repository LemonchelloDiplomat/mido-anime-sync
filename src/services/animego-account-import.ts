import type { AnimeIdentity, AnimeListEntry, AnimeStatus } from "../core/types.js";

export interface AnimeGoAccountRawEntry {
  animeId: string;
  title: string;
  originalTitle?: string | null;
  posterUrl?: string | null;
  score?: number | string | null;
  href?: string | null;
}

export interface AnimeGoAccountListPayload {
  listType: number;
  sourceUrl: string;
  entries: unknown[];
}

export interface NormalizedAnimeGoAccountList {
  status: AnimeStatus;
  rows: Array<{ anime: AnimeIdentity; entry: AnimeListEntry }>;
  skipped: number;
}

const STATUS_BY_LIST_TYPE: Record<number, AnimeStatus> = {
  1: "WATCHING",
  2: "COMPLETED",
  3: "ON_HOLD",
  4: "DROPPED",
  5: "PLANNING",
  6: "REWATCHING",
};

function safeAnimeGoProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:") &&
      (host === "animego.me" || host.endsWith(".animego.me") ||
        host === "anime-go.org" || host.endsWith(".anime-go.org") ||
        host === "animego.online" || host.endsWith(".animego.online")) &&
      /^\/(?:profile|user)\//.test(url.pathname);
  } catch {
    return false;
  }
}

/** Normalize a single user-selected AnimeGO profile list. No remote writes or deletes occur. */
export function normalizeAnimeGoAccountList(
  payload: AnimeGoAccountListPayload,
  now = new Date().toISOString(),
): NormalizedAnimeGoAccountList {
  const status = STATUS_BY_LIST_TYPE[payload.listType];
  if (!status) throw new Error("Неизвестный тип списка AnimeGO.");
  if (!safeAnimeGoProfileUrl(payload.sourceUrl)) {
    throw new Error("Импорт AnimeGO разрешён только со страницы собственного профиля или списка пользователя.");
  }
  if (!Array.isArray(payload.entries) || payload.entries.length > 5000) {
    throw new Error("AnimeGO вернул некорректный размер списка (максимум 5000 записей за импорт).");
  }

  const rows: NormalizedAnimeGoAccountList["rows"] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of payload.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skipped += 1;
      continue;
    }
    const raw = value as Partial<AnimeGoAccountRawEntry>;
    const animeId = String(raw.animeId ?? "").trim();
    const title = String(raw.title ?? "").trim();
    if (!/^\d+$/.test(animeId) || !title || title.length > 300 || seen.has(animeId)) {
      skipped += 1;
      continue;
    }
    seen.add(animeId);
    const originalTitle = typeof raw.originalTitle === "string" ? raw.originalTitle.trim().slice(0, 300) : "";
    const scoreValue = raw.score == null || raw.score === "" ? null : Number(raw.score);
    const scoreKnown = scoreValue !== null && Number.isFinite(scoreValue) && scoreValue >= 1 && scoreValue <= 10;
    const posterUrl = typeof raw.posterUrl === "string" && /^https:\/\//i.test(raw.posterUrl)
      ? raw.posterUrl.slice(0, 2048)
      : null;
    const anime: AnimeIdentity = {
      id: "animego:" + animeId,
      titles: { romaji: title, synonyms: originalTitle && originalTitle !== title ? [originalTitle] : [] },
      externalIds: { animego: animeId },
      posterUrl,
    };
    const entry: AnimeListEntry = {
      animeId: anime.id,
      status,
      progress: 0,
      score: scoreKnown ? Math.round(scoreValue! * 10) : null,
      favorite: false,
      updatedAt: now,
      source: "animego",
      sourceMetadata: {
        listType: payload.listType,
        progressKnown: false,
        scoreKnown,
        favoriteKnown: false,
      },
    };
    rows.push({ anime, entry });
  }
  return { status, rows, skipped };
}
