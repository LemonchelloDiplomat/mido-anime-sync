import { Resolver } from "node:dns";
import { get as httpsGet } from "node:https";

const SITE = "https://animego.me";
const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedAddress = null;
let cachedAddressUntil = 0;

export function resolve4Async(resolver, hostname) {
  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

async function resolveAnimeGoAddress() {
  if (cachedAddress && Date.now() < cachedAddressUntil) return cachedAddress;
  let lastError;
  for (const server of DNS_SERVERS) {
    const resolver = new Resolver();
    resolver.setServers([server]);
    try {
      const [address] = await resolve4Async(resolver, "animego.me");
      if (!address) throw new Error("Публичный DNS не вернул IPv4-адрес AnimeGO.");
      cachedAddress = address;
      cachedAddressUntil = Date.now() + DNS_CACHE_TTL_MS;
      return address;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Не удалось разрешить animego.me через публичные DNS-серверы: " +
    (lastError instanceof Error ? lastError.message : String(lastError)));
}

function requestAnimeGo(url, { headers = {} } = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "animego.me") {
    return Promise.reject(new Error("AnimeGO request заблокирован: недопустимый адрес."));
  }
  return resolveAnimeGoAddress().then((address) => new Promise((resolve, reject) => {
    const req = httpsGet(target, {
      headers,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        const status = response.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("Превышено время ожидания ответа AnimeGO.")));
    req.on("error", reject);
  }));
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

export function parseAnimeGoSearch(html) {
  const results = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*href\s*=\s*(['"])([^'"]*\/anime\/[^'"]+)\2[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html))) {
    const href = safeUrl(match[3]);
    if (!href || seen.has(href)) continue;
    const inner = match[4];
    const image = inner.match(/<img\b[^>]*>/i)?.[0] || "";
    const title = stripTags(inner) || attr(image, "alt");
    if (!title) continue;
    const prefix = html.slice(Math.max(0, match.index - 1200), match.index);
    const imageTags = [...prefix.matchAll(/<img\b[^>]*>/gi)];
    const imageTag = imageTags.at(-1)?.[0] || image;
    const poster = safeUrl(attr(imageTag, "data-src") || attr(imageTag, "src"));
    const slug = new URL(href).pathname.split("/").filter(Boolean).at(-1) || href;
    results.push({
      provider: "animego",
      externalId: slug,
      url: href,
      title,
      alternativeTitles: [],
      posterUrl: poster,
    });
    seen.add(href);
  }
  return results.slice(0, 30);
}

export function parseAnimeGoDetail(html, url) {
  const canonicalTag = html.match(/<link\b[^>]*rel\s*=\s*(['"])canonical\1[^>]*>/i)?.[0] || "";
  const ogTitleTag = html.match(/<meta\b[^>]*property\s*=\s*(['"])og:title\1[^>]*>/i)?.[0] || "";
  const ogImageTag = html.match(/<meta\b[^>]*property\s*=\s*(['"])og:image\1[^>]*>/i)?.[0] || "";
  const descTag = html.match(/<meta\b[^>]*name\s*=\s*(['"])description\1[^>]*>/i)?.[0] || "";
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  const canonical = safeUrl(attr(canonicalTag, "href") || url);
  const title = stripTags(h1) || stripTags(attr(ogTitleTag, "content")).replace(/\s*[-|].*$/, "");
  if (!canonical || !title) throw new Error("AnimeGO не вернул распознаваемую публичную карточку аниме.");
  const jsonLdRaw = html.match(/<script\b[^>]*type\s*=\s*(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/i)?.[2] || "";
  let jsonLd = {};
  try { jsonLd = JSON.parse(jsonLdRaw); } catch {}
  const year = Number(String(jsonLd.datePublished || "").slice(0, 4)) || null;
  const genres = Array.isArray(jsonLd.genre) ? jsonLd.genre.map(String) : [];
  const rating = Number(jsonLd.aggregateRating?.ratingValue);
  const slug = new URL(canonical).pathname.split("/").filter(Boolean).at(-1) || canonical;
  const id = slug.match(/-(\d+)$/)?.[1] || slug;
  const poster = safeUrl(attr(ogImageTag, "content"));
  return {
    provider: "animego",
    externalId: id,
    url: canonical,
    title,
    alternativeTitles: [String(jsonLd.alternateName || "")].filter(Boolean),
    posterUrl: poster,
    description: stripTags(attr(descTag, "content")) || null,
    year,
    episodeCount: Number(jsonLd.numberOfEpisodes) || null,
    identity: {
      id: "animego:" + id,
      titles: { romaji: title, synonyms: [String(jsonLd.alternateName || "")].filter(Boolean) },
      externalIds: { animego: id },
      year,
      episodes: Number(jsonLd.numberOfEpisodes) || null,
      genres,
      posterUrl: poster,
      averageScore: Number.isFinite(rating) && rating > 0 ? rating : null,
    },
  };
}

function playerContent(payload) {
  const content = payload?.data?.content;
  if (typeof content !== "string") throw new Error("AnimeGO вернул список эпизодов в неожиданном формате.");
  return content;
}

export function parseAnimeGoVoices(payload) {
  const content = playerContent(payload);
  const voices = [];
  const buttonPattern = /<button\b[^>]*>/gi;
  let match;
  while ((match = buttonPattern.exec(content))) {
    const tag = match[0];
    const rawEmbed = attr(tag, "data-player").trim();
    const name = decodeHtml(attr(tag, "data-translation-title")).replace(/\s*\(ошибка\)\s*$/i, "").trim();
    if (!rawEmbed || !name) continue;
    const embed = safeUrl(rawEmbed);
    if (!embed) continue;
    const playerName = decodeHtml(attr(tag, "data-provider-title")).trim() || "Неизвестный плеер";
    const translationId = attr(tag, "data-ptranslation");
    voices.push({
      externalId: [translationId || name, playerName, voices.length + 1].join(":"),
      name,
      playerName,
      playerUrl: embed,
    });
  }
  return voices;
}

export function parseAnimeGoPlayer(payload, titleUrl) {
  const content = playerContent(payload);
  const episodes = [];
  const episodePattern = /<([a-z][\w:-]*)\b([^>]*\bclass\s*=\s*(['"])[^'"]*\bplayer-video-bar__item\b[^'"]*\3[^>]*)>/gi;
  let match;
  while ((match = episodePattern.exec(content))) {
    const number = Number(attr(match[2], "data-episode-number"));
    const id = attr(match[2], "data-episode");
    if (!Number.isFinite(number) || number <= 0 || !/^\d+$/.test(id)) continue;
    episodes.push({
      externalId: id,
      number,
      title: attr(match[2], "data-episode-title") || null,
      url: titleUrl,
      seasonNumber: Number(attr(match[2], "data-season")) || 1,
    });
  }
  episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
  const uniqueEpisodes = [...new Map(episodes.map((episode) => [episode.externalId, episode])).values()];
  return { episodes: uniqueEpisodes, voices: parseAnimeGoVoices(payload) };
}

export async function handleAnimeGoRequest(request, response, url, deps) {
  const { sendJson } = deps;
  const requestAnimeGoImpl = deps.request || requestAnimeGo;
  const method = request.method || "GET";
  if (!url.pathname.startsWith("/api/animego/")) return false;
  if (method !== "GET") return sendJson(response, 405, { error: "AnimeGO поддерживает только чтение публичного каталога." });
  const headers = {
    Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  };
  try {
    if (url.pathname === "/api/animego/search") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 2 || query.length > 120) return sendJson(response, 400, { error: "Поисковый запрос должен содержать от 2 до 120 символов." });
      const page = await requestAnimeGoImpl(SITE + "/search/anime?" + new URLSearchParams({ q: query }), { headers });
      if (!page.ok) throw new Error("AnimeGO: HTTP " + page.status);
      return sendJson(response, 200, { items: parseAnimeGoSearch(await page.text()), page: 1, hasNextPage: false });
    }
    const episodeMatch = url.pathname.match(/^\/api\/animego\/episode\/(\d+)$/);
    if (episodeMatch) {
      const player = await requestAnimeGoImpl(SITE + "/player/videos/" + encodeURIComponent(episodeMatch[1]), {
        headers: { ...headers, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: SITE + "/" },
      });
      if (!player.ok) throw new Error("AnimeGO player: HTTP " + player.status);
      const voices = parseAnimeGoVoices(await player.json());
      return sendJson(response, 200, { voices });
    }
    const match = url.pathname.match(/^\/api\/animego\/anime\/([^/]+)$/);
    if (match) {
      const slug = decodeURIComponent(match[1]);
      if (!/^[\p{L}\p{N}-]+$/u.test(slug)) return sendJson(response, 400, { error: "Некорректный AnimeGO slug." });
      const page = await requestAnimeGoImpl(SITE + "/anime/" + encodeURIComponent(slug), { headers });
      if (!page.ok) throw new Error("AnimeGO: HTTP " + page.status);
      const detail = parseAnimeGoDetail(await page.text(), SITE + "/anime/" + encodeURIComponent(slug));
      const player = await requestAnimeGoImpl(SITE + "/player/" + encodeURIComponent(detail.externalId), {
        headers: { ...headers, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: SITE + "/" },
      });
      let parsed = { episodes: [], voices: [] };
      if (player.ok) parsed = parseAnimeGoPlayer(await player.json(), detail.url);
      return sendJson(response, 200, {
        ...detail,
        seasons: parsed.episodes.length ? [{ number: 1, title: "Основной сезон", episodes: parsed.episodes }] : [],
        voices: parsed.voices,
      });
    }
    if (url.pathname === "/api/animego/status") {
      return sendJson(response, 200, {
        catalogSearch: true,
        titleDetails: true,
        seasonsAndEpisodes: true,
        voiceTracks: true,
        accountConnection: false,
        listImport: false,
        watchProgressRead: "browser-extension",
        limitations: ["У AnimeGO не подтверждён официальный публичный API личного кабинета. Прогресс просмотра передаётся существующим расширением."],
      });
    }
    return sendJson(response, 404, { error: "Маршрут AnimeGO не найден." });
  } catch (error) {
    return sendJson(response, 502, { error: error instanceof Error ? error.message : "Не удалось получить данные AnimeGO." });
  }
}
