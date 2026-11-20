const SITE = "https://anixart.site";
const playerCatalogs = new Map();
const PLAYER_CATALOG_TTL_MS = 10 * 60 * 1000;

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
    sourceMetadata: { playerTitleId: playerId || null, publisherId: publisherId || null },
  };
}

export async function handleAnixArtRequest(request, response, url, deps) {
  const { sendJson } = deps;
  const method = request.method || "GET";
  if (!url.pathname.startsWith("/api/anixart/")) return false;

  if (url.pathname === "/api/anixart/player-catalog") {
    if (method === "POST") {
      if (typeof deps.readJson !== "function") return sendJson(response, 503, { error: "Приём каталога AnixART не настроен." });
      const body = await deps.readJson(request, 512 * 1024);
      const catalog = sanitizePlayerCatalog(body);
      if (!catalog) return sendJson(response, 400, { error: "Некорректная структура каталога AnixART." });
      playerCatalogs.set(catalog.slug, { catalog, expiresAt: Date.now() + PLAYER_CATALOG_TTL_MS });
      return sendJson(response, 200, { ok: true, seasonCount: catalog.seasons.length });
    }
    if (method === "GET") {
      const slug = String(url.searchParams.get("slug") || "");
      if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug)) return sendJson(response, 400, { error: "Некорректный AnixART slug." });
      const cached = playerCatalogs.get(slug);
      if (!cached || cached.expiresAt <= Date.now()) {
        playerCatalogs.delete(slug);
        return sendJson(response, 200, { catalog: null });
      }
      return sendJson(response, 200, { catalog: cached.catalog });
    }
    return sendJson(response, 405, { error: "Метод не поддерживается." });
  }

  if (method !== "GET") return sendJson(response, 405, { error: "AnixART поддерживает только чтение публичного каталога и приём данных плеера." });
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  };
  try {
    if (url.pathname === "/api/anixart/search") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 2 || query.length > 120) return sendJson(response, 400, { error: "Поисковый запрос должен содержать от 2 до 120 символов." });
      const searchUrl = SITE + "/?do=search&subaction=search&story=" + encodeURIComponent(query);
      const page = await fetch(searchUrl, { headers });
      if (!page.ok) throw new Error("AnixART: HTTP " + page.status);
      return sendJson(response, 200, { items: parseAnixArtSearch(await page.text()), page: 1, hasNextPage: false });
    }
    const match = url.pathname.match(/^\/api\/anixart\/anime\/([^/]+)$/);
    if (match) {
      const slug = decodeURIComponent(match[1]);
      if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug)) return sendJson(response, 400, { error: "Некорректный AnixART slug." });
      const page = await fetch(SITE + "/" + encodeURIComponent(slug), { headers });
      if (!page.ok) throw new Error("AnixART: HTTP " + page.status);
      return sendJson(response, 200, parseAnixArtDetail(await page.text(), SITE + "/" + encodeURIComponent(slug)));
    }
    if (url.pathname === "/api/anixart/status") {
      return sendJson(response, 200, {
        catalogSearch: true,
        titleDetails: true,
        episodeCount: "player-catalog",
        voiceTracks: true,
        fullSeasonEpisodeManifest: true,
        playerCatalogBridge: true,
        accountConnection: false,
        listImport: false,
        watchProgressRead: "browser-extension",
        limitations: [
          "Сайт anixart.site сам указывает, что он не связан с мобильным приложением Anixart. Аккаунты сайта и приложения нельзя считать одним профилем.",
          "Полный каталог сезонов, серий и озвучек передаётся расширением из состояния плеера в локальный интерфейс после открытия тайтла на сайте.",
          "Выбор серии и озвучки, а также встроенное воспроизведение пока остаются на сайте AnixART.",
          "Неофициальный reverse-engineered API приложения не используется для входа или синхронизации аккаунта.",
        ],
      });
    }
    return sendJson(response, 404, { error: "Маршрут AnixART не найден." });
  } catch (error) {
    return sendJson(response, 502, { error: error instanceof Error ? error.message : "Не удалось получить данные AnixART." });
  }
}
