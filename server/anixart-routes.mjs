import { Readable } from "node:stream";

const SITE = "https://anixart.site";
const CVH_API = "https://plapi.cdnvideohub.com/api/v1/player/sv";
const CVH_PLAYER = "https://player.cdnvideohub.com/";
function sanitizePlayerCatalog(input) {
  if (!input || typeof input !== "object" ||
      typeof input.slug !== "string" || !/^\d+-[\p{L}\p{N}-]+\.html$/u.test(input.slug) ||
      typeof input.title !== "string" || input.title.trim().length < 2 ||
      !Array.isArray(input.seasons)) return null;
  const seasons = input.seasons.slice(0, 50).flatMap((season) => {
    const number = Number(season?.number);
    if (!Number.isSafeInteger(number) || number < 1 || !Array.isArray(season.episodes)) return [];
    const episodes = season.episodes.slice(0, 500).flatMap((episode) => {
      const episodeNumber = Number(episode?.number);
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1 || !Array.isArray(episode.voices)) return [];
      const voiceMap = new Map();
      for (const voice of episode.voices.slice(0, 100)) {
        let name = typeof voice?.name === "string" ? voice.name.trim().slice(0, 100) : "";
        let type = typeof voice?.type === "string" ? voice.type.trim().slice(0, 60) : "";
        if (!name) continue;
        if (/^субтитры$/i.test(name) && !type) {
          name = "Студия не указана";
          type = "Субтитры";
        }
        const key = name.toLocaleLowerCase() + "\\u0000" + type.toLocaleLowerCase();
        if (!voiceMap.has(key)) voiceMap.set(key, { name, type: type || null });
      }
      const voices = [...voiceMap.values()];
      return [{ number: episodeNumber, title: typeof episode.title === "string" ? episode.title.slice(0, 120) : String(episodeNumber), voices }];
    });
    episodes.sort((a, b) => a.number - b.number);
    return [{ number, episodes }];
  });
  seasons.sort((a, b) => a.number - b.number);
  if (!seasons.length) return null;
  const current = input.current && typeof input.current === "object" ? input.current : {};
  const currentSeason = Number(current.season);
  const currentEpisode = Number(current.episode);
  return {
    slug: input.slug,
    title: input.title.trim().slice(0, 200),
    seasons,
    current: {
      season: Number.isSafeInteger(currentSeason) && currentSeason > 0 ? currentSeason : null,
      episode: Number.isSafeInteger(currentEpisode) && currentEpisode > 0 ? currentEpisode : null,
      voice: typeof current.voice === "string" ? current.voice.trim().slice(0, 100) : null,
    },
    receivedAt: new Date().toISOString(),
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attr(tag, name) {
  const match = String(tag).match(new RegExp("\\b" + name + "\\s*=\\s*(['\"])(.*?)\\1", "i"));
  return match ? decodeHtml(match[2]) : "";
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function safeUrl(value, base = SITE) {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function titleSlug(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1) || "";
}

function cleanSearchTitle(value) {
  return String(value || "")
    .replace(/^\s*(?:\d{1,2}(?:[.,]\d{1,2})?\s+){1,2}/, "")
    .replace(/\s+\d{4}\s*,[\s\S]*$/, "")
    .replace(/[\s,;|]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAnixArtSearch(html) {
  const items = [];
  const seen = new Set();
  const pattern = /<a\b([^>]*href\s*=\s*(['"])([^'"]+\.html(?:\?[^'"]*)?)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const url = safeUrl(match[3]);
    if (!url || new URL(url).hostname !== "anixart.site" || seen.has(url)) continue;
    const slug = titleSlug(url);
    if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug)) continue;
    const inner = match[4];
    const image = inner.match(/<img\b[^>]*>/i)?.[0] || "";
    const title = cleanSearchTitle(stripTags(inner)) || cleanSearchTitle(attr(image, "alt"));
    if (!title) continue;
    const prefix = html.slice(Math.max(0, match.index - 1400), match.index);
    const images = [...prefix.matchAll(/<img\b[^>]*>/gi)];
    const posterTag = images.at(-1)?.[0] || image;
    const poster = safeUrl(attr(posterTag, "data-src") || attr(posterTag, "src"));
    items.push({
      provider: "anixart",
      externalId: slug,
      url,
      title,
      alternativeTitles: [],
      posterUrl: poster,
    });
    seen.add(url);
  }
  return items.slice(0, 30);
}

function sectionLinks(html, label) {
  const match = html.match(new RegExp(label + "\\s*:?([\\s\\S]{0,3500}?)<\\/li>", "i"));
  if (!match) return [];
  const values = [];
  const pattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let link;
  while ((link = pattern.exec(match[1]))) {
    const value = stripTags(link[1]);
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

export function parseAnixArtDetail(html, requestedUrl) {
  const canonicalTag = html.match(/<link\b[^>]*rel\s*=\s*(['"])canonical\1[^>]*>/i)?.[0] || "";
  const ogImageTag = html.match(/<meta\b[^>]*property\s*=\s*(['"])og:image\1[^>]*>/i)?.[0] || "";
  const descriptionTag = html.match(/<meta\b[^>]*name\s*=\s*(['"])description\1[^>]*>/i)?.[0] || "";
  const playerTag = html.match(/<video-player\b[^>]*>/i)?.[0] || "";
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  const canonical = safeUrl(attr(canonicalTag, "href") || requestedUrl);
  const title = stripTags(h1);
  if (!canonical || !title) throw new Error("AnixART не вернул распознаваемую публичную карточку.");
  const slug = titleSlug(canonical);
  const id = slug.match(/^(\d+)-/)?.[1] || attr(playerTag, "data-title-id");
  const playerId = attr(playerTag, "data-title-id");
  const publisherId = attr(playerTag, "data-publisher-id");
  const aggregator = attr(playerTag, "data-aggregator") || "mali";
  const bodyText = stripTags(html);
  const yearMatch = bodyText.match(/(?:Год|Год выпуска)\s*:\s*(20\d{2}|19\d{2})/i);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const voices = sectionLinks(html, "Озвучка").map((name, index) => ({
    externalId: "voice:" + index + ":" + name.toLocaleLowerCase(),
    name,
  }));
  const genres = sectionLinks(html, "Жанр");
  const poster = safeUrl(attr(ogImageTag, "content"));
  const description = stripTags(attr(descriptionTag, "content")) || null;
  const identityId = id || slug;
  return {
    provider: "anixart",
    externalId: slug,
    url: canonical,
    title,
    alternativeTitles: [],
    posterUrl: poster,
    description,
    year,
    episodeCount: null,
    identity: {
      id: "anixart:" + identityId,
      titles: { romaji: title, synonyms: [] },
      externalIds: { anixart: identityId },
      year,
      episodes: null,
      genres,
      posterUrl: poster,
    },
    seasons: [],
    voices,
    sourceMetadata: { playerTitleId: playerId || null, publisherId: publisherId || null, aggregator },
  };
}

export function parseAnixArtPlayerPlaylist(payload, titleUrl) {
  const rows = Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.data?.items) ? payload.data.items : [];
  const seasons = new Map();
  const voices = new Map();
  for (const row of rows) {
    const seasonNumber = Number(row?.season) || 1;
    const episodeNumber = Number(row?.episode);
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) continue;
    const voiceName = String(row?.voiceStudio || row?.voice || "").trim() || "Озвучка не указана";
    const voiceType = String(row?.voiceType || "").trim() || null;
    const season = seasons.get(seasonNumber) || new Map();
    const episode = season.get(episodeNumber) || {
      externalId: "anixart:" + seasonNumber + ":" + episodeNumber,
      number: episodeNumber,
      title: String(row?.name || episodeNumber),
      url: titleUrl,
      seasonNumber,
      voiceTracks: [],
    };
    const voiceKey = voiceName.toLocaleLowerCase() + "\u0000" + String(voiceType || "").toLocaleLowerCase();
    const videoId = String(row?.vkId || "").trim();
    if (!episode.voiceTracks.some((track) => track.externalId === voiceKey)) {
      episode.voiceTracks.push({
        externalId: voiceKey,
        name: voiceName,
        playerName: voiceType || "CVH",
        // The numeric CVH video id is transient and only used by the local stream proxy.
        playerUrl: /^\d+$/.test(videoId) ? "/api/anixart/stream/" + videoId : null,
      });
    }
    season.set(episodeNumber, episode);
    seasons.set(seasonNumber, season);
    if (!voices.has(voiceKey)) voices.set(voiceKey, { externalId: voiceKey, name: voiceName, playerName: voiceType || "CVH" });
  }
  const mappedSeasons = [...seasons.entries()].sort(([a], [b]) => a - b).map(([number, episodes]) => ({
    number,
    title: "Сезон " + number,
    episodes: [...episodes.values()].sort((a, b) => a.number - b.number),
  }));
  return {
    seasons: mappedSeasons,
    voices: [...voices.values()].sort((a, b) => a.name.localeCompare(b.name)),
    episodeCount: mappedSeasons.reduce((total, season) => total + season.episodes.length, 0),
  };
}

export function selectAnixArtVideoSource(payload) {
  const sources = payload && typeof payload === "object" && payload.sources && typeof payload.sources === "object"
    ? payload.sources : {};
  const preferredKeys = [
    "mpeg4kUrl", "mpeg2kUrl", "mpegQhdUrl", "mpegFullHdUrl",
    "mpegHighUrl", "mpegMediumUrl", "mpegLowUrl", "mpegLowestUrl",
    "mpegTinyUrl", "mpegMobileUrl",
  ];
  for (const key of preferredKeys) {
    const value = sources[key];
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const candidate = new URL(value);
      if (candidate.protocol === "https:" &&
          (candidate.hostname === "okcdn.ru" || candidate.hostname.endsWith(".okcdn.ru") ||
           candidate.hostname === "vkuser.net" || candidate.hostname.endsWith(".vkuser.net"))) {
        return candidate.toString();
      }
    } catch {}
  }
  return null;
}

export async function handleAnixArtRequest(request, response, url, deps) {
  const { sendJson } = deps;
  const method = request.method || "GET";
  if (!url.pathname.startsWith("/api/anixart/")) return false;
  if (method !== "GET") return sendJson(response, 405, { error: "AnixART поддерживает только чтение публичного каталога." });

  const fetcher = deps.fetch || fetch;
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    Referer: SITE + "/",
  };
  try {
    if (url.pathname === "/api/anixart/search") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 2 || query.length > 120) return sendJson(response, 400, { error: "Поисковый запрос должен содержать от 2 до 120 символов." });
      const searchUrl = SITE + "/?do=search&subaction=search&story=" + encodeURIComponent(query);
      const page = await fetcher(searchUrl, { headers });
      if (!page.ok) throw new Error("AnixART: HTTP " + page.status);
      return sendJson(response, 200, { items: parseAnixArtSearch(await page.text()), page: 1, hasNextPage: false });
    }

    const streamMatch = url.pathname.match(/^\/api\/anixart\/stream\/(\d+)$/);
    if (streamMatch) {
      const videoId = streamMatch[1];
      const playerHeaders = {
        Accept: "application/json",
        "User-Agent": headers["User-Agent"],
        Referer: CVH_PLAYER,
        Origin: "https://player.cdnvideohub.com",
      };
      const metadata = await fetcher(CVH_API + "/video/" + videoId, { headers: playerHeaders });
      if (!metadata.ok) throw new Error("AnixART CVH video metadata: HTTP " + metadata.status);
      const sourceUrl = selectAnixArtVideoSource(await metadata.json());
      if (!sourceUrl) throw new Error("CVH не вернул поддерживаемую MP4-ссылку для этой озвучки.");

      const upstreamHeaders = {
        "User-Agent": headers["User-Agent"],
        Referer: CVH_PLAYER,
        Origin: "https://player.cdnvideohub.com",
      };
      const range = request.headers?.range;
      if (typeof range === "string" && /^bytes=\d*-\d*$/.test(range)) upstreamHeaders.Range = range;
      const upstream = await fetcher(sourceUrl, { headers: upstreamHeaders });
      if (!upstream.ok && upstream.status !== 206) {
        throw new Error("CVH video CDN: HTTP " + upstream.status);
      }
      const responseHeaders = {
        "Content-Type": upstream.headers?.get("content-type") || "video/mp4",
        "Accept-Ranges": upstream.headers?.get("accept-ranges") || "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      for (const name of ["content-length", "content-range"]) {
        const value = upstream.headers?.get(name);
        if (value) responseHeaders[name] = value;
      }
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(response);
      } else {
        response.end(Buffer.from(await upstream.arrayBuffer()));
      }
      return true;
    }

    const match = url.pathname.match(/^\/api\/anixart\/anime\/([^/]+)$/);
    if (match) {
      const slug = decodeURIComponent(match[1]);
      if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug)) return sendJson(response, 400, { error: "Некорректный AnixART slug." });
      const titleUrl = SITE + "/" + encodeURIComponent(slug);
      const page = await fetcher(titleUrl, { headers });
      if (!page.ok) throw new Error("AnixART: HTTP " + page.status);
      const detail = parseAnixArtDetail(await page.text(), titleUrl);
      const playerTitleId = String(detail.sourceMetadata?.playerTitleId || "");
      const publisherId = String(detail.sourceMetadata?.publisherId || "");
      const aggregator = String(detail.sourceMetadata?.aggregator || "mali");
      let playerCatalog = { seasons: [], voices: [], episodeCount: null };
      if (/^\d+$/.test(playerTitleId) && /^\d+$/.test(publisherId) && /^[a-z0-9_-]{1,32}$/i.test(aggregator)) {
        const playlistUrl = new URL("https://plapi.cdnvideohub.com/api/v1/player/sv/playlist");
        playlistUrl.search = new URLSearchParams({ pub: publisherId, aggr: aggregator, id: playerTitleId }).toString();
        const playlist = await fetcher(playlistUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent": headers["User-Agent"],
            Referer: CVH_PLAYER,
            Origin: "https://player.cdnvideohub.com",
          },
        });
        if (playlist.ok) {
          playerCatalog = parseAnixArtPlayerPlaylist(await playlist.json(), detail.url);
        } else {
          throw new Error("AnixART CVH playlist: HTTP " + playlist.status);
        }
      }
      return sendJson(response, 200, {
        ...detail,
        seasons: playerCatalog.seasons,
        voices: playerCatalog.voices.length ? playerCatalog.voices : detail.voices,
        episodeCount: playerCatalog.episodeCount,
        identity: {
          ...detail.identity,
          episodes: playerCatalog.episodeCount || null,
        },
      });
    }

    if (url.pathname === "/api/anixart/status") {
      return sendJson(response, 200, {
        catalogSearch: true,
        titleDetails: true,
        fullSeasonEpisodeManifest: true,
        playerCatalogSource: "server-cvh-api",
        accountConnection: false,
        listImport: false,
        watchProgressRead: "browser-extension",
        limitations: [
          "Каталог сезонов, серий и озвучек загружается локальным сервером из публичного CVH playlist API.",
          "Синхронизация аккаунта мобильного приложения AnixART не поддерживается.",
          "Видеопотоки CVH разрешаются локальным сервером и передаются встроенному HTML5-плееру через потоковый прокси.",
        ],
      });
    }
    return sendJson(response, 404, { error: "Маршрут AnixART не найден." });
  } catch (error) {
    return sendJson(response, 502, { error: error instanceof Error ? error.message : "Не удалось получить данные AnixART." });
  }
}
