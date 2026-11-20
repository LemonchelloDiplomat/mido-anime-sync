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
      let timer;
      const addresses = await Promise.race([
        resolve4Async(resolver, "animego.me"),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            resolver.cancel();
            reject(new Error("Тайм-аут DNS AnimeGO (5 секунд)."));
          }, 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      const [address] = addresses;
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
    req.setTimeout(15000, () => req.destroy(new Error("AnimeGO не ответил за 15 секунд. Попробуй ещё раз.")));
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
  const match = String(tag).match(new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}function stripTags(value) {
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

function posterFromCard(card) {
  const source = String(card || "");
  const candidates = [];
  const tags = [...source.matchAll(/<[a-z][\w:-]*\b[^>]*>/gi)].map((match) => match[0]);
  const attributes = ["data-original", "data-original-src", "data-lazy-src", "data-src", "data-cfsrc", "data-image", "data-poster", "data-background", "data-bg", "src"];
  for (const tag of tags) {
    for (const name of attributes) {
      const value = attr(tag, name);
      if (value) candidates.push(value);
    }
    for (const name of ["data-srcset", "srcset"]) {
      const value = attr(tag, name);
      if (!value) continue;
      const choices = value.split(",").map((entry) => {
        const [url, descriptor] = entry.trim().split(/\s+/);
        const width = Number(descriptor?.replace(/w$/i, "")) || 0;
        return { url, width };
      }).filter((entry) => entry.url);
      choices.sort((a, b) => b.width - a.width);
      candidates.push(...choices.map((entry) => entry.url));
    }
    const style = attr(tag, "style");
    const background = style.match(/(?:background(?:-image)?|--poster)\s*:\s*url\((['"]?)(.*?)\1\)/i)?.[2];
    if (background) candidates.push(background);
  }
  for (const match of source.matchAll(/\bstyle\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))/gi)) {
    const style = match[2] ?? match[3] ?? "";
    const background = style.match(/(?:background(?:-image)?|--poster)\s*:\s*url\((['"]?)(.*?)\1\)/i)?.[2];
    if (background) candidates.push(background);
  }
  for (const candidate of candidates) {
    const value = decodeHtml(candidate).trim();
    if (!value || /^(?:data:|blob:|javascript:)/i.test(value) || /(?:placeholder|no[-_]?image|default[-_]?poster)/i.test(value)) continue;
    const url = safeUrl(value);
    if (url) return url;
  }
  return null;
}

function normalizeAnimeGoSearchText(value) {
  const cyrillicToLatin = {
    а:"a", б:"b", в:"v", г:"g", д:"d", е:"e", ё:"yo", ж:"zh", з:"z", и:"i",
    й:"y", к:"k", л:"l", м:"m", н:"n", о:"o", п:"p", р:"r", с:"s", т:"t",
    у:"u", ф:"f", х:"kh", ц:"ts", ч:"ch", ш:"sh", щ:"shch", ъ:"", ы:"y",
    ь:"", э:"e", ю:"yu", я:"ya",
  };
  return decodeHtml(String(value || ""))
    .toLocaleLowerCase("ru")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[а-яё]/g, (letter) => cyrillicToLatin[letter] ?? letter)
    .replace(/ё/g, "yo")
    .replace(/[^\\p{L}\\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function animeGoSimilarity(query, candidate) {
  const q = normalizeAnimeGoSearchText(query);
  const value = normalizeAnimeGoSearchText(candidate);
  if (!q || !value) return 0;
  if (q === value) return 1;
  if (value.includes(q) || q.includes(value)) return 0.96;

  const qTokens = q.split(" ").filter((token) => token.length > 1);
  const vTokens = value.split(" ").filter((token) => token.length > 1);
  const tokenScore = qTokens.length
    ? qTokens.filter((token) => vTokens.some((other) =>
        other === token || other.startsWith(token) || token.startsWith(other) ||
        (token.length >= 5 && other.length >= 5 && (token.includes(other) || other.includes(token)))
      )).length / qTokens.length
    : 0;

  // Work on Unicode code points so Japanese, Korean and other scripts are not
  // discarded by an ASCII-only tokenizer. This is especially important for
  // Japanese titles, which are commonly written without spaces.
  const grams = (text) => {
    const padded = [" ", " ", ...Array.from(text), " ", " "];
    const result = new Set();
    for (let i = 0; i <= padded.length - 3; i += 1) result.add(padded.slice(i, i + 3).join(""));
    return result;
  };
  const a = grams(q);
  const b = grams(value);
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  const dice = (2 * overlap) / (a.size + b.size);
  return Math.max(tokenScore * 0.82, dice);
}

export function parseAnimeGoSearch(html) {
  // AnimeGO pages contain navigation links to /anime/... alongside actual search cards.
  // Only inspect the dedicated ani-grid__item containers, never arbitrary page anchors.
  const divTags = [...String(html || "").matchAll(/<div\b[^>]*>/gi)];
  // Match the exact class token. A substring regex also matched
  // "ani-grid__item-picture", which is a nested image wrapper, not a card.
  const cardStarts = divTags
    .filter((match) => attr(match[0], "class").split(/\s+/).includes("ani-grid__item"))
    .map((match) => match.index);
  const results = [];
  const seen = new Set();

  for (let index = 0; index < cardStarts.length; index += 1) {
    const card = String(html).slice(cardStarts[index], cardStarts[index + 1] ?? String(html).length);
    const anchors = [...card.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
    let selectedAnchor = null;
    let selectedUrl = null;
    for (const anchor of anchors) {
      const openingTag = anchor[0].slice(0, anchor[0].indexOf(">") + 1);
      const href = attr(openingTag, "href");
      const candidate = safeUrl(href);
      if (!candidate) continue;
      const pathname = new URL(candidate).pathname;
      if (/^\/anime\/[\p{L}\p{N}-]+-\d+\/?$/u.test(pathname)) {
        selectedAnchor = openingTag;
        selectedUrl = candidate;
        break;
      }
    }
    if (!selectedAnchor || !selectedUrl || seen.has(selectedUrl)) continue;

    const image = card.match(/<img\b[^>]*>/i)?.[0] || "";
    const title = attr(selectedAnchor, "title") || attr(image, "alt") ||
      anchors.map((anchor) => attr(anchor[0].slice(0, anchor[0].indexOf(">") + 1), "title") || stripTags(anchor[1]))
        .find(Boolean) || "";

    if (!title) continue;

    const cardText = stripTags(card);
    const aliases = [...new Set([
      title,
      attr(image, "alt"),
      ...[...card.matchAll(/<a\b[^>]*>/gi)].map((entry) => attr(entry[0], "title")),
      cardText,
    ].filter(Boolean))];
    const poster = posterFromCard(card);
    const slug = new URL(selectedUrl).pathname.split("/").filter(Boolean).at(-1) || selectedUrl;
    results.push({
      provider: "animego",
      externalId: slug,
      url: selectedUrl,
      title,
      alternativeTitles: aliases.filter((alias) => alias !== title).slice(0, 8),
      posterUrl: poster,
    });
    seen.add(selectedUrl);
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
    if (url.pathname === "/api/animego/poster") {
      const raw = String(url.searchParams.get("url") || "");
      let target;
      try { target = new URL(raw); } catch { return sendJson(response, 400, { error: "Некорректный адрес постера AnimeGO." }); }
      const allowedHost = (hostname) => ["cdngos.com", "animego.me", "animego.org", "animego.online"].some((domain) => hostname === domain || hostname.endsWith("." + domain));
      if (target.protocol !== "https:" || !allowedHost(target.hostname)) {
        return sendJson(response, 400, { error: "Источник постера AnimeGO не разрешён." });
      }
      const imageFetcher = deps.fetch || fetch;
      // Poster hosts occasionally stall or rate-limit. Bound both the response
      // headers and body read so one bad CDN image cannot hang a catalog card.
      const imageSignal = AbortSignal.timeout(12000);
      let image;
      try {
        image = await imageFetcher(target.toString(), {
          headers: { ...headers, Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", Referer: SITE + "/" },
          redirect: "follow",
          signal: imageSignal,
        });
      } catch (error) {
        if (imageSignal.aborted) throw new Error("CDN AnimeGO не отдал постер за 12 секунд.");
        throw error;
      }
      const finalUrl = new URL(image.url || target.toString());
      if (!image.ok) throw new Error("AnimeGO poster: HTTP " + image.status);
      if (finalUrl.protocol !== "https:" || !allowedHost(finalUrl.hostname)) {
        return sendJson(response, 502, { error: "AnimeGO перенаправил постер на неизвестный источник." });
      }
      const contentType = image.headers?.get("content-type") || "application/octet-stream";
      if (!contentType.toLowerCase().startsWith("image/")) {
        return sendJson(response, 502, { error: "AnimeGO вместо изображения вернул другой тип данных." });
      }
      let bytes;
      try {
        bytes = Buffer.from(await image.arrayBuffer());
      } catch (error) {
        if (imageSignal.aborted) throw new Error("Загрузка файла постера AnimeGO превысила 12 секунд.");
        throw error;
      }
      if (bytes.length > 8 * 1024 * 1024) return sendJson(response, 413, { error: "Постер AnimeGO превышает допустимый размер." });
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(bytes);
      return true;
    }
    if (url.pathname === "/api/animego/search") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 2 || query.length > 120) return sendJson(response, 400, { error: "Поисковый запрос должен содержать от 2 до 120 символов." });
      const searchQuery = new URLSearchParams({ q: query }).toString();
      let page = await requestAnimeGoImpl(SITE + "/search/anime?" + searchQuery, { headers });
      // AnimeGO mirrors have used both routes. Retry the alternate public search route on 404.
      if (page.status === 404) {
        page = await requestAnimeGoImpl(SITE + "/search/all?" + searchQuery, { headers });
      }
      if (!page.ok) throw new Error("AnimeGO: HTTP " + page.status);
      const parsedItems = parseAnimeGoSearch(await page.text());
      const rankedItems = parsedItems
        .map((item) => ({
          item,
          score: Math.max(...[item.title, ...(item.alternativeTitles || [])]
            .map((candidate) => animeGoSimilarity(query, candidate))),
        }))
        .filter((entry) => entry.score >= 0.24)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item);
      return sendJson(response, 200, { items: rankedItems.slice(0, 20), page: 1, hasNextPage: false });
    }
    const episodeMatch = url.pathname.match(/^\/api\/animego\/episode\/(\d+)$/);
    if (episodeMatch) {
      const player = await requestAnimeGoImpl(SITE + "/player/videos/" + encodeURIComponent(episodeMatch[1]), {
        headers: { ...headers, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: SITE + "/" },
      });
      if (!player.ok) throw new Error("AnimeGO player: HTTP " + player.status);
      const payload = typeof player.json === "function" ? await player.json() : JSON.parse(await player.text());
      const voices = parseAnimeGoVoices(payload);
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
      if (player.ok) {
        const payload = typeof player.json === "function" ? await player.json() : JSON.parse(await player.text());
        parsed = parseAnimeGoPlayer(payload, detail.url);
      }
      // AnimeGO films can expose player variants without an episode navigation bar.
      // Surface those variants as one synthetic "Фильм" item so the existing player UI can render them.
      const episodes = parsed.episodes.length
        ? parsed.episodes
        : parsed.voices.length
          ? [{
              externalId: detail.externalId,
              number: 1,
              title: "Фильм",
              url: detail.url,
              seasonNumber: 1,
              voiceTracks: parsed.voices,
            }]
          : [];
      return sendJson(response, 200, {
        ...detail,
        seasons: episodes.length ? [{ number: 1, title: "Основной сезон", episodes }] : [],
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
