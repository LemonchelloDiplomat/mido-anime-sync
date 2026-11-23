const SITE_ORIGIN = "https://animego.me";
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attribute(tag, name) {
  const match = String(tag).match(new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function classTokens(tag) {
  return attribute(tag, "class").split(/\s+/).filter(Boolean);
}

function stripTags(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract balanced DIV blocks, including cards with nested DIV wrappers. */
function extractDivBlocks(html) {
  const source = String(html ?? "");
  const tokenPattern = /<\/?div\b[^>]*>/gi;
  const stack = [];
  const blocks = [];
  let token;

  while ((token = tokenPattern.exec(source))) {
    if (!/^<\//.test(token[0])) {
      stack.push({
        start: token.index,
        openingTag: token[0],
        innerStart: tokenPattern.lastIndex,
      });
      continue;
    }

    const opening = stack.pop();
    if (!opening) continue;
    blocks.push({
      html: source.slice(opening.start, tokenPattern.lastIndex),
      innerHtml: source.slice(opening.innerStart, token.index),
      openingTag: opening.openingTag,
      classNames: classTokens(opening.openingTag),
    });
  }
  return blocks.sort((a, b) => a.html.length - b.html.length);
}

function safeAnimeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "animego.me") return null;
    if (!/^\/anime\/[\p{L}\p{N}-]+-\d+\/?$/u.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function posterUrlFromCard(cardHtml, baseUrl) {
  const image = String(cardHtml).match(/<img\b[^>]*>/i)?.[0] ?? "";
  for (const name of ["src", "data-src", "data-original", "data-lazy-src", "data-original-src"]) {
    const raw = attribute(image, name);
    if (!raw || /^(?:data:|blob:|javascript:)/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      const trustedHost = url.hostname === "img.cdngos.com" ||
        url.hostname === "animego.me" ||
        url.hostname.endsWith(".cdngos.com");
      if (!trustedHost || !["https:", "http:"].includes(url.protocol)) continue;
      url.protocol = "https:";
      return url.toString();
    } catch {
      // Try the next supported image attribute.
    }
  }
  return null;
}

function parseProgress(cardHtml) {
  const anchors = String(cardHtml).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
    const href = attribute(openingTag, "href");
    if (!href.includes("#player")) continue;
    const text = stripTags(match[1]);
    const progress = text.match(/(?:Продолжить|Начать)\s*(\d+)\s*\/\s*(\d+)/i);
    if (!progress) return { episodesWatched: null, episodesTotal: null, progressText: text || null };
    return {
      episodesWatched: Number(progress[1]),
      episodesTotal: Number(progress[2]),
      progressText: text,
    };
  }
  return { episodesWatched: null, episodesTotal: null, progressText: null };
}

function parseNextPage(html, baseUrl) {
  const frames = String(html).matchAll(/<turbo-frame\b[^>]*>/gi);
  for (const match of frames) {
    const tag = match[0];
    const id = attribute(tag, "id");
    const rawSrc = attribute(tag, "src");
    if (!id || !rawSrc || !/^profile-my-list-page-\d+$/.test(id)) continue;

    try {
      const url = new URL(rawSrc, baseUrl);
      if (url.origin !== SITE_ORIGIN || !/^\/user\/mylist\/\d+\/\d+$/.test(url.pathname)) continue;
      const type = url.searchParams.get("type");
      if (!type || !/^\d+$/.test(type)) continue;
      return { nextPageFrameId: id, nextPageUrl: url.pathname + url.search };
    } catch {
      // Ignore malformed or off-site frame URLs.
    }
  }
  return { nextPageFrameId: null, nextPageUrl: null };
}

/**
 * Parses an AnimeGO personal-list Turbo Stream response.
 *
 * listType is preserved as a numeric source field. .user-profile__status is
 * the anime release badge (e.g. онгоинг), not the user's list status.
 * data-rating values are opaque and are deliberately not interpreted.
 */
export function parseAnimeGoMyListResponse(html, options = {}) {
  const source = String(html ?? "");
  if (source.length > MAX_RESPONSE_CHARS) {
    throw new Error("AnimeGO my-list response exceeds the 2 MB parser limit.");
  }

  const baseUrl = new URL(options.baseUrl || SITE_ORIGIN + "/");
  if (baseUrl.origin !== SITE_ORIGIN) {
    throw new Error("AnimeGO my-list parser only accepts animego.me response URLs.");
  }

  const listType = Number(options.listType ?? 1);
  if (!Number.isSafeInteger(listType) || listType < 1 || listType > 6) {
    throw new Error("AnimeGO list type must be an integer from 1 to 6.");
  }

  const cards = extractDivBlocks(source).filter((block) =>
    block.classNames.includes("user-mylist__item")
  );
  const items = [];
  const seen = new Set();

  for (const card of cards) {
    const listEntryId = attribute(card.openingTag, "data-mylist-id");
    if (!/^\d+$/.test(listEntryId) || seen.has(listEntryId)) continue;

    const anchors = [...card.innerHtml.matchAll(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)];
    let animeUrl = null;
    for (const anchor of anchors) {
      const openingTag = anchor[0].slice(0, anchor[0].indexOf(">") + 1);
      const candidate = safeAnimeUrl(attribute(openingTag, "href"), baseUrl);
      if (candidate) {
        animeUrl = candidate;
        break;
      }
    }
    if (!animeUrl) continue;

    const nestedDivs = extractDivBlocks(card.innerHtml);
    const titleBlock = nestedDivs.find((block) => block.classNames.includes("user-mylist__title"));
    const titleAnchor = titleBlock?.innerHtml.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const image = card.innerHtml.match(/<img\b[^>]*>/i)?.[0] ?? "";
    const title = stripTags(titleAnchor?.[1] ?? "") || attribute(image, "alt");
    if (!title) continue;

    const alternativeBlock = nestedDivs.find((block) =>
      block.classNames.includes("fw-lighter") && block.classNames.includes("small")
    );
    const alternativeTitle = stripTags(alternativeBlock?.innerHtml ?? "") || null;
    const releaseBlock = nestedDivs.find((block) => block.classNames.includes("user-profile__status"));
    const releaseStatus = stripTags(releaseBlock?.innerHtml ?? "") || null;
    const progress = parseProgress(card.innerHtml);
    const animeSlug = animeUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const animeId = animeSlug.match(/-(\d+)$/)?.[1] ?? null;

    items.push({
      provider: "animego",
      listEntryId,
      animeId,
      animeSlug,
      url: animeUrl.toString(),
      title,
      alternativeTitle,
      posterUrl: posterUrlFromCard(card.innerHtml, baseUrl),
      listType,
      releaseStatus,
      ...progress,
    });
    seen.add(listEntryId);
  }

  return { items, ...parseNextPage(source, baseUrl) };
}
