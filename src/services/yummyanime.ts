import type { AnimeIdentity, AnimeListEntry, AnimeSnapshotV4 } from "../core/types.js";
import type {
  StreamingCatalogProvider,
  StreamingEpisode,
  StreamingSearchQuery,
  StreamingSearchResult,
  StreamingTitle,
  StreamingTitleDetails,
  StreamingVoice,
} from "./streaming-provider.js";

type JsonRecord = Record<string, unknown>;

const API_BASE = "https://api.yani.tv";
const SITE_BASE = "https://yummyani.me";

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function videoData(value: unknown): JsonRecord {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value === "string") {
    try { return record(JSON.parse(value)) || {}; } catch { return {}; }
  }
  return {};
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unwrap(payload: unknown): unknown {
  const root = record(payload);
  return root && "response" in root ? root.response : payload;
}

function safeHttpUrl(value: unknown, base = SITE_BASE): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw, base);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function posterUrl(value: unknown): string | null {
  if (typeof value === "string") return safeHttpUrl(value);
  const poster = record(value);
  return safeHttpUrl(poster?.huge || poster?.fullsize || poster?.big || poster?.medium);
}

function titleFrom(rawValue: unknown): StreamingTitle | null {
  const raw = record(rawValue);
  if (!raw) return null;
  const id = number(raw.anime_id ?? raw.id);
  const title = text(raw.title);
  const url = safeHttpUrl(raw.anime_url || raw.url || (text(raw.alias) ? "/catalog/item/" + text(raw.alias) : id ? "/catalog/item/" + id : ""));
  const rawRating = number(record(raw.rating)?.average ?? raw.rating);
  const rating = rawRating !== null && rawRating >= 0 && rawRating <= 10 ? rawRating : null;
  if (!id || !title || !url) return null;
  const alternatives = Array.isArray(raw.other_titles)
    ? raw.other_titles.map(text).filter(Boolean)
    : [];
  return {
    provider: "yummyanime",
    externalId: String(id),
    url,
    title,
    alternativeTitles: [...new Set([text(raw.original_title), text(raw.japanese), ...alternatives].filter(Boolean))],
    posterUrl: posterUrl(raw.poster),
    description: text(raw.description) || null,
    year: number(raw.year),
    episodeCount: number(record(raw.episodes)?.count),
    ...(rating !== null ? { rating } : {}),
  };
}

function parseRows(payload: unknown): unknown[] {
  const data = record(unwrap(payload));
  if (Array.isArray(unwrap(payload))) return unwrap(payload) as unknown[];
  for (const key of ["anime", "results", "items", "data"]) {
    if (Array.isArray(data?.[key])) return data[key] as unknown[];
  }
  return [];
}

function mapFormat(value: unknown): AnimeIdentity["format"] {
  switch (text(value).toLowerCase()) {
    case "tv": return "TV";
    case "movie": return "MOVIE";
    case "ova": return "OVA";
    case "ona": return "ONA";
    case "special": return "SPECIAL";
    case "music": return "MUSIC";
    default: return undefined;
  }
}

function mapStatus(value: unknown): AnimeIdentity["releaseStatus"] {
  switch (text(value).toLowerCase()) {
    case "ongoing": return "ONGOING";
    case "announced": return "ANNOUNCED";
    case "released": return "RELEASED";
    default: return undefined;
  }
}

function identityFrom(rawValue: unknown): AnimeIdentity | null {
  const raw = record(rawValue);
  const title = titleFrom(rawValue);
  if (!raw || !title) return null;
  const ids = record(raw.remote_ids) || {};
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((item) => text(record(item)?.title)).filter(Boolean)
    : [];
  const rating = number(record(raw.rating)?.average ?? raw.rating);
  return {
    id: "yummyanime:" + title.externalId,
    titles: {
      romaji: title.title,
      ...(text(raw.original_title) ? { native: text(raw.original_title) } : {}),
      synonyms: title.alternativeTitles,
    },
    externalIds: {
      yummyanime: title.externalId,
      ...(number(ids.myanimelist_id) ? { myanimelist: String(ids.myanimelist_id) } : {}),
      ...(number(ids.shikimori_id) ? { shikimori: String(ids.shikimori_id) } : {}),
    },
    year: title.year ?? null,
    ...(mapFormat(raw.type) ? { format: mapFormat(raw.type)! } : {}),
    episodes: title.episodeCount ?? null,
    genres,
    posterUrl: title.posterUrl ?? null,
    averageScore: rating,
    ...(rating !== null ? { providerScores: { yummyanime: {
      averageScore: { value: rating, scale: 10, normalizedValue: rating * 10, kind: "average" as const },
    } } } : {}),
    providerMetadata: {
      yummyanime: {
        type: raw.type ?? null,
        animeStatus: record(raw.anime_status)?.alias ?? null,
        remoteIds: ids,
        rawRating: record(raw.rating)?.average ?? raw.rating ?? null,
      },
    },
    ...(mapStatus(record(raw.anime_status)?.alias) ? { releaseStatus: mapStatus(record(raw.anime_status)?.alias)! } : {}),
  };
}

function episodeNumber(value: unknown): number | null {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseVideos(payload: unknown, titleUrl: string): { episodes: StreamingEpisode[]; voices: StreamingVoice[] } {
  const rows = parseRows(payload);
  const episodeMap = new Map<string, StreamingEpisode>();
  const voiceMap = new Map<string, StreamingVoice>();

  for (const value of rows) {
    const raw = record(value);
    if (!raw) continue;
    const id = number(raw.video_id ?? raw.id);
    const episodeNumberValue = episodeNumber(raw.number ?? raw.index);
    if (!id || !episodeNumberValue) continue;

    const seasonNumber = number(raw.season) || 1;
    const data = videoData(raw.data);
    const voiceName = text(data.dubbing || data.translation || data.voice || data.title || data.player) || "Озвучка не указана";
    const playerName = text(data.player || data.source || data.service || data.player_id) || null;
    // Provider URLs are held only in live detail state because they may contain temporary tokens.
    const playerUrl = safeHttpUrl(raw.iframe_url || raw.url || raw.player_url || raw.link || data.iframe_url || data.url || data.player_url || data.link);
    const videoId = String(id);
    const episodeKey = seasonNumber + ":" + episodeNumberValue;
    let episode = episodeMap.get(episodeKey);

    if (!episode) {
      episode = {
        externalId: videoId,
        number: episodeNumberValue,
        title: text(raw.title) || null,
        url: titleUrl,
        seasonNumber,
        voiceTracks: [],
      };
      episodeMap.set(episodeKey, episode);
    } else if (!episode.title && text(raw.title)) {
      episode.title = text(raw.title);
    }

    // Each API video row represents a concrete voice/player variant for this episode.
    // Keep its ID, but never expose iframe URLs that may contain temporary tokens.
    if (!episode.voiceTracks?.some((track) => track.externalId === videoId)) {
      episode.voiceTracks?.push({ externalId: videoId, name: voiceName, playerUrl, playerName });
    }

    const voiceKey = voiceName.toLocaleLowerCase();
    const aggregate = voiceMap.get(voiceKey);
    if (aggregate) {
      if (!aggregate.episodeIds?.includes(videoId)) aggregate.episodeIds?.push(videoId);
    } else {
      voiceMap.set(voiceKey, { externalId: voiceKey, name: voiceName, episodeIds: [videoId] });
    }
  }

  const episodes = [...episodeMap.values()].sort((a, b) =>
    (a.seasonNumber || 1) - (b.seasonNumber || 1) || a.number - b.number
  );
  for (const episode of episodes) {
    episode.voiceTracks?.sort((a, b) => a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId));
  }
  return {
    episodes,
    voices: [...voiceMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function parseYummySearch(payload: unknown, page = 1): StreamingSearchResult {
  const items = parseRows(payload).map((raw) => {
    const title = titleFrom(raw);
    const identity = identityFrom(raw);
    return title ? { ...title, ...(identity ? { identity } : {}) } : null;
  }).filter((item): item is StreamingTitle => item !== null);
  const envelope = record(unwrap(payload));
  const limit = number(envelope?.limit) || items.length;
  const offset = number(envelope?.offset) || (page - 1) * limit;
  const total = number(envelope?.total);
  return { items, page, hasNextPage: total !== null ? offset + items.length < total : items.length >= limit };
}

export function parseYummyDetails(payload: unknown, videosPayload?: unknown): StreamingTitleDetails {
  const raw = record(unwrap(payload));
  const title = titleFrom(raw);
  if (!raw || !title) throw new Error("YummyAnime вернул карточку аниме в неожиданном формате.");
  const parsedVideos = videosPayload === undefined
    ? { episodes: [], voices: [] }
    : parseVideos(videosPayload, title.url);
  const episodes = parsedVideos.episodes;
  const seasonGroups = new Map<number, StreamingEpisode[]>();
  for (const episode of episodes) {
    const seasonNumber = episode.seasonNumber || 1;
    const group = seasonGroups.get(seasonNumber) || [];
    group.push(episode);
    seasonGroups.set(seasonNumber, group);
  }
  const seasons = [...seasonGroups.entries()].sort(([a], [b]) => a - b).map(([number, seasonEpisodes]) => ({
    number,
    title: "Сезон " + number,
    episodes: seasonEpisodes,
  }));
  return { ...title, ...(identityFrom(raw) ? { identity: identityFrom(raw)! } : {}), seasons, voices: parsedVideos.voices };
}

export function parseYummyAccountSnapshot(
  payload: unknown,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  const rows = parseRows(payload);
  const anime: AnimeIdentity[] = [];
  const entries: AnimeListEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const outer = record(row);
    const raw = record(outer?.anime) || outer;
    const user = record(outer?.user) || record(raw?.user) || {};
    const userList = record(user.list) || {};
    const list = record(userList.list) || {};
    const identity = identityFrom(raw);
    if (!identity) throw new Error("В списке YummyAnime найдена запись без корректного ID или названия.");
    const externalId = identity.externalIds.yummyanime!;
    if (seen.has(externalId)) throw new Error("YummyAnime вернул повторяющийся ID: " + externalId);
    seen.add(externalId);
    const statusId = number(list.id);
    const status = statusId === 0 ? "WATCHING"
      : statusId === 1 ? "PLANNING"
      : statusId === 2 ? "COMPLETED"
      : statusId === 3 ? "DROPPED"
      : statusId === 5 ? "ON_HOLD"
      : null;
    if (!status) continue;
    const timestamp = number(outer?.date ?? raw?.date);
    const updatedAt = timestamp ? new Date(timestamp * 1000).toISOString() : exportedAt;
    const entry: AnimeListEntry = {
      animeId: identity.id,
      status,
      progress: Math.max(0, number(userList.progress ?? userList.watched_episodes) || 0),
      score: (number(user.rate) || 0) > 0 ? Math.round((number(user.rate) || 0) * 10) : null,
      favorite: Boolean(userList.is_fav),
      updatedAt,
      source: "yummyanime",
      sourceMetadata: {
        yummyanimeListId: statusId,
        originalScore: user.rate ?? null,
        scoreScale: 10,
      },
    };
    anime.push(identity);
    entries.push(entry);
  }
  return {
    schemaVersion: 4,
    exportedAt,
    anime,
    entries,
    sourceEntries: structuredClone(entries),
    conflictResolutions: [],
    animeRelations: [],
  };
}

export function parseYummyWatchHistory(
  payload: unknown,
  exportedAt = new Date().toISOString(),
): AnimeSnapshotV4 {
  const grouped = new Map<string, { anime: AnimeIdentity; progress: number; updatedAt: string; videoIds: string[]; time: number; duration: number }>();
  for (const row of parseRows(payload)) {
    const raw = record(row);
    if (!raw) continue;
    const id = number(raw.anime_id ?? raw.animeId);
    const title = text(raw.title ?? raw.anime_title);
    const episode = episodeNumber(raw.episode ?? raw.number);
    if (!id || !title || !episode) continue;
    const key = String(id);
    const poster = posterUrl(raw.poster);
    const timestamp = number(raw.date ?? raw.updated_at);
    const updatedAt = timestamp ? new Date(timestamp * 1000).toISOString() : exportedAt;
    const anime: AnimeIdentity = {
      id: "yummyanime:" + key,
      titles: { romaji: title, synonyms: [] },
      externalIds: { yummyanime: key },
      posterUrl: poster,
      episodes: null,
    };
    const existing = grouped.get(key);
    const videoId = String(number(raw.video_id ?? raw.videoId) || "");
    const time = Math.max(0, number(raw.end_time ?? raw.time) || 0);
    const duration = Math.max(0, number(raw.duration) || 0);
    if (!existing) {
      grouped.set(key, { anime, progress: episode, updatedAt, videoIds: videoId ? [videoId] : [], time, duration });
    } else {
      existing.progress = Math.max(existing.progress, episode);
      if (Date.parse(updatedAt) > Date.parse(existing.updatedAt)) {
        existing.updatedAt = updatedAt;
        existing.time = time;
        existing.duration = duration;
      }
      if (videoId && !existing.videoIds.includes(videoId)) existing.videoIds.push(videoId);
      if (!existing.anime.posterUrl && poster) existing.anime.posterUrl = poster;
    }
  }
  const anime = [...grouped.values()].map((item) => item.anime);
  const entries: AnimeListEntry[] = [...grouped.entries()].map(([id, item]) => ({
    animeId: "yummyanime:" + id,
    status: "WATCHING",
    progress: item.progress,
    score: null,
    favorite: false,
    updatedAt: item.updatedAt,
    source: "yummyanime",
    sourceMetadata: { videoIds: item.videoIds, lastPositionSeconds: item.time, lastDurationSeconds: item.duration },
  }));
  return {
    schemaVersion: 4,
    exportedAt,
    anime,
    entries,
    sourceEntries: structuredClone(entries),
    conflictResolutions: [],
    animeRelations: [],
  };
}

export class YummyAnimeCatalogProvider implements StreamingCatalogProvider {
  readonly id = "yummyanime" as const;
  readonly name = "YummyAnime";
  readonly capabilities = {
    catalogSearch: true,
    titleDetails: true,
    seasonsAndEpisodes: true,
    voiceTracks: true,
  };

  constructor(
    private readonly applicationToken: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiBase = API_BASE,
    private readonly language = "ru",
  ) {
    if (!applicationToken.trim()) throw new Error("Для YummyAnime нужен X-Application token. Создай приложение на сайте YummyAnime и добавь токен в локальные настройки.");
  }

  private async request(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(this.apiBase + path, {
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        "X-Application": this.applicationToken,
        Lang: this.language,
      },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = text(record(payload)?.error_title || record(payload)?.message || record(payload)?.error);
      throw new Error(message || "YummyAnime API: HTTP " + response.status);
    }
    if (record(payload)?.error) throw new Error(text(record(payload)?.error_title || record(payload)?.error));
    return payload;
  }

  async search(query: StreamingSearchQuery): Promise<StreamingSearchResult> {
    const params = new URLSearchParams({ q: query.query.trim(), limit: "20", offset: String(Math.max(0, ((query.page || 1) - 1) * 20)) });
    return parseYummySearch(await this.request("/search?" + params, query.signal), query.page || 1);
  }

  async getTitle(externalId: string, signal?: AbortSignal): Promise<StreamingTitleDetails> {
    if (!/^\d+$/.test(externalId) && !/^[a-z0-9-]+$/i.test(externalId)) throw new Error("Некорректный YummyAnime ID.");
    const detail = await this.request("/anime/" + encodeURIComponent(externalId), signal);
    const raw = record(unwrap(detail));
    const videos = raw ? await this.request("/anime/" + encodeURIComponent(String(raw.anime_id || externalId)) + "/videos", signal) : undefined;
    return parseYummyDetails(detail, videos);
  }
}
