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
  const match = String(tag).match(new RegExp("\\b" + name + "\\s*=\\s*(?:(['\"])(.*?)\\1|([^\\s>]+))", "i"));
  return match ? decodeHtml(match[2] ?? match[3] ?? "") : "";
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

function posterFromCard(card) {
  const source = String(card || "");
  const candidates = [];
  const tags = [...source.matchAll(/<[a-z][\\w:-]*\\b[^>]*>/gi)].map((match) => match[0]);
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
        const [url, descriptor] = entry.trim().split(/\\s+/);
        const width = Number(descriptor?.replace(/w$/i, "")) || 0;
        return { url, width };
      }).filter((entry) => entry.url);
      choices.sort((a, b) => b.width - a.width);
      candidates.push(...choices.map((entry) => entry.url));
    }
    const style = attr(tag, "style");
    const background = style.match(/(?:background(?:-image)?|--poster)\\s*:\\s*url\\((['"]?)(.*?)\\1\\)/i)?.[2];
    if (background) candidates.push(background);
  }
  for (const match of source.matchAll(/\\bstyle\\s*=\\s*(?:(['"])(.*?)\\1|([^\\s>]+))/gi)) {
    const style = match[2] ?? match[3] ?? "";
    const background = style.match(/(?:background(?:-image)?|--poster)\\s*:\\s*url\\((['"]?)(.*?)\\1\\)/i)?.[2];
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

