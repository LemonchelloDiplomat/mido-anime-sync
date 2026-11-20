const SITE = "https://animego.org";

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

export function parseAnimeGoPlayer(payload, titleUrl) {
  const content = payload?.data?.content;
  if (typeof content !== "string") throw new Error("AnimeGO вернул список эпизодов в неожиданном формате.");
  const episodes = [];
  const episodePattern = /<([a-z][\w:-]*)\b([^>]*\bclass\s*=\s*(['"])[^'"]*\bplayer-video-bar__item\b[^'"]*\3[^>]*)>/gi;
  let match;
  while ((match = episodePattern.exec(content))) {
    const number = Number(attr(match[2], "data-episode-number"));
    const id = attr(match[2], "data-episode");
    if (!Number.isFinite(number) || number <= 0 || !id) continue;
    episodes.push({
      externalId: id,
      number,
      title: attr(match[2], "data-episode-title") || null,
      url: titleUrl,
      seasonNumber: Number(attr(match[2], "data-season")) || 1,
    });
  }
  const voices = [];
  const voicePattern = /<button\b([^>]*\bdata-translation\s*=\s*(['"])(.*?)\2[^>]*)>([\s\S]*?)<\/button>/gi;
  const seen = new Set();
  while ((match = voicePattern.exec(content))) {
    const id = attr(match[1], "data-translation");
    const name = stripTags(match[4]);
    if (!id || !name || seen.has(id)) continue;
    voices.push({ externalId: id, name });
    seen.add(id);
  }
  episodes.sort((a, b) => a.number - b.number);
  return { episodes, voices };
}

export async function handleAnimeGoRequest(request, response, url, deps) {
  const { sendJson } = deps;
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
      const page = await fetch(SITE + "/search/anime?" + new URLSearchParams({ q: query }), { headers });
      if (!page.ok) throw new Error("AnimeGO: HTTP " + page.status);
      return sendJson(response, 200, { items: parseAnimeGoSearch(await page.text()), page: 1, hasNextPage: false });
    }
    const match = url.pathname.match(/^\/api\/animego\/anime\/([^/]+)$/);
    if (match) {
      const slug = decodeURIComponent(match[1]);
      if (!/^[\p{L}\p{N}-]+$/u.test(slug)) return sendJson(response, 400, { error: "Некорректный AnimeGO slug." });
      const page = await fetch(SITE + "/anime/" + encodeURIComponent(slug), { headers });
      if (!page.ok) throw new Error("AnimeGO: HTTP " + page.status);
      const detail = parseAnimeGoDetail(await page.text(), SITE + "/anime/" + encodeURIComponent(slug));
      const player = await fetch(SITE + "/player/" + encodeURIComponent(detail.externalId), { headers: { ...headers, Accept: "application/json" } });
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
