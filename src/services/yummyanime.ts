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
  const url = safeHttpUrl(raw.anime_url || raw.url || (text(raw.alias) ? "/catalog/item/" + text(raw.alias) : ""));
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
  const date = number(raw.updated_at);
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
    year: title.year,
    ...(mapFormat(raw.type) ? { format: mapFormat(raw.type)! } : {}),
    episodes: title.episodeCount,
    genres,
    posterUrl: title.posterUrl,
    averageScore: rating,
    ...(mapStatus(record(raw.anime_status)?.alias) ? { releaseStatus: mapStatus(record(raw.anime_status)?.alias)! } : {}),
    ...(date ? { startDate: new Date(date * 1000).toISOString().slice(0, 10) } : {}),
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
  const episodes: StreamingEpisode[] = [];
  const voiceMap = new Map<string, StreamingVoice>();
  for (const value of rows) {
    const raw = record(value);
    if (!raw) continue;
    const id = number(raw.video_id ?? raw.id);
    const episode = episodeNumber(raw.number ?? raw.index);
    const data = record(raw.data) || {};
    const voice = text(data.dubbing || data.translation || data.voice || data.title);
    if (!id || !episode) continue;
    // Deliberately retain only public episode metadata. iframe/player URLs can
    // contain short-lived tokens and are not needed to open the title page.
    episodes.push({
      externalId: String(id),
      number: episode,
      title: text(raw.title) || null,
      url: titleUrl,
    });
    if (voice) {
      const key = voice.toLocaleLowerCase();
      const existing = voiceMap.get(key);
      if (existing) existing.episodeIds?.push(String(id));
      else voiceMap.set(key, { externalId: key, name: voice, episodeIds: [String(id)] });
    }
  }
  episodes.sort((a, b) => a.number - b.number || a.externalId.localeCompare(b.externalId));
  return { episodes, voices: [...voiceMap.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function parseYummySearch(payload: unknown, page = 1): StreamingSearchResult {
  const items = parseRows(payload).map(titleFrom).filter((item): item is StreamingTitle => item !== null);
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
  const seasons = episodes.length ? [{
    number: 1,
    title: "Основной сезон",
    episodes,
  }] : [];
  return { ...title, seasons, voices: parsedVideos.voices };
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
      sourceMetadata: { yummyanimeListId: statusId },
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
      signal,
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
