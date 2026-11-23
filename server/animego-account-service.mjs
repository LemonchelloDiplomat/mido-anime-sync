import { parseAnimeGoLoginForm } from "./animego-login-form-parser.mjs";
import { parseAnimeGoMyListResponse } from "./animego-mylist-parser.mjs";

const SITE_ORIGIN = "https://animego.me";
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 1500;
const MAX_PAGES_PER_LIST = 50;
const MAX_ITEMS = 3000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readAttribute(tag, name) {
  const match = String(tag).match(new RegExp(
    "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i",
  ));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function readUserFromHtml(html) {
  const htmlTag = String(html).match(/<html\b[^>]*>/i)?.[0] ?? "";
  const raw = readAttribute(htmlTag, "data-user");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const id = String(value?.id ?? value?.userId ?? "");
    if (!/^\d+$/.test(id)) return null;
    const label = [value?.username, value?.login, value?.name, value?.nickname]
      .find((entry) => typeof entry === "string" && entry.trim());
    return { id, label: label ? String(label).trim().slice(0, 100) : null };
  } catch {
    return null;
  }
}

function responseSetCookies(headers) {
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers?.get?.("set-cookie");
  if (!combined) return [];
  return String(combined).split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function updateCookieJar(jar, headers) {
  for (const line of responseSetCookies(headers)) {
    const first = String(line).split(";", 1)[0];
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (!value || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => name + "=" + value).join("; ");
}

async function readBoundedText(response, maxChars = MAX_HTML_CHARS) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxChars * 4) {
    throw new Error("AnimeGO вернул слишком большой ответ.");
  }
  const text = await response.text();
  if (text.length > maxChars) throw new Error("AnimeGO вернул слишком большой ответ.");
  return text;
}

async function upstreamRequest(fetcher, jar, path, options = {}) {
  let url = new URL(path, SITE_ORIGIN);
  if (url.origin !== SITE_ORIGIN) throw new Error("Запрос к AnimeGO за пределами разрешённого домена заблокирован.");

  let method = String(options.method || "GET").toUpperCase();
  let body = options.body;
  let headers = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": USER_AGENT,
    Referer: SITE_ORIGIN + "/",
    ...(options.headers || {}),
  };

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const cookies = cookieHeader(jar);
    if (cookies) headers.Cookie = cookies;
    let response;
    try {
      response = await fetcher(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const code = error?.cause?.code || error?.code || null;
      const timedOut = error?.name === "TimeoutError" ||
        code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT";
      const reason = timedOut
        ? "Истекло время ожидания ответа."
        : code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? "Не удалось найти адрес сервера (DNS)."
          : code === "ECONNRESET" || code === "ECONNREFUSED"
            ? "Соединение было сброшено или отклонено."
            : code && String(code).startsWith("CERT_")
              ? "Не удалось проверить TLS-сертификат."
              : "Проверь интернет, DNS, VPN и настройки брандмауэра.";
      throw new Error(
        "Не удалось связаться с AnimeGO (" + method + " " + url.hostname + "). " +
        reason + (code ? " Код: " + String(code).slice(0, 64) + "." : ""),
      );
    }
    updateCookieJar(jar, response.headers);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel?.();
      if (!location) throw new Error("AnimeGO вернул перенаправление без адреса.");
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== SITE_ORIGIN) {
        throw new Error("AnimeGO попытался перенаправить авторизацию на другой домен. Перенаправление заблокировано.");
      }
      if (redirects === MAX_REDIRECTS) throw new Error("AnimeGO превысил лимит перенаправлений.");
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        const { "Content-Type": _contentType, ...safeHeaders } = headers;
        headers = safeHeaders;
      }
      url = nextUrl;
      continue;
    }

    return {
      status: response.status,
      ok: response.ok,
      url: url.toString(),
      headers: response.headers,
      text: await readBoundedText(response),
    };
  }
  throw new Error("Не удалось завершить запрос к AnimeGO.");
}

async function withAnimeGoRateLimit(operation, intervalMs = REQUEST_INTERVAL_MS) {
  const previous = requestQueue;
  let release;
  requestQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastRequestAt + Math.max(0, intervalMs) - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return await operation();
  } finally {
    release();
  }
}

function getStoredAccount(tokens) {
  return tokens.streamingAccounts?.animego ?? null;
}

async function saveStoredAccount(readTokens, writeTokens, account) {
  const tokens = await readTokens();
  tokens.streamingAccounts ??= {};
  tokens.streamingAccounts.animego = account;
  await writeTokens(tokens);
}

async function clearStoredAccount(readTokens, writeTokens) {
  const tokens = await readTokens();
  if (tokens.streamingAccounts) {
    delete tokens.streamingAccounts.animego;
    if (!Object.keys(tokens.streamingAccounts).length) delete tokens.streamingAccounts;
    await writeTokens(tokens);
  }
}

function statusFromAccount(account) {
  if (!account?.cookies || !account?.userId) {
    return {
      provider: "animego", adapterAvailable: true,
      status: {
        provider: "animego", connected: false, connectedAt: null, expiresAt: null,
        accountLabel: null, state: "disconnected", errorMessage: null,
      },
    };
  }
  return {
    provider: "animego", adapterAvailable: true,
    status: {
      provider: "animego", connected: true,
      connectedAt: account.connectedAt ?? null,
      expiresAt: account.expiresAt ?? null,
      accountLabel: account.accountLabel ?? null,
      state: "connected", errorMessage: null,
    },
  };
}

async function validateAccount(fetcher, account) {
  if (!account?.cookies || !/^\d+$/.test(String(account.userId ?? ""))) return null;
  const jar = new Map(account.cookies);
  const home = await upstreamRequest(fetcher, jar, "/");
  if (!home.ok) return null;
  const user = readUserFromHtml(home.text);
  if (!user || user.id !== String(account.userId)) return null;
  return {
    ...account,
    cookies: [...jar.entries()],
    accountLabel: user.label || account.accountLabel || null,
  };
}

export async function getAnimeGoAccountStatus({ readTokens, writeTokens, fetcher = fetch }) {
  const tokens = await readTokens();
  const account = getStoredAccount(tokens);
  if (!account) return statusFromAccount(null);
  try {
    const valid = await validateAccount(fetcher, account);
    if (!valid) {
      await clearStoredAccount(readTokens, writeTokens);
      return statusFromAccount(null);
    }
    await saveStoredAccount(readTokens, writeTokens, valid);
    return statusFromAccount(valid);
  } catch {
    // Network failures should not erase a potentially valid session.
    return statusFromAccount(account);
  }
}

export async function connectAnimeGoAccount(input, { readTokens, writeTokens, fetcher = fetch }) {
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  const rememberMe = input?.rememberMe === true;
  if (!username || username.length > 256 || !password || password.length > 1024) {
    throw new Error("Укажи логин и пароль AnimeGO.");
  }

  const jar = new Map();
  const loginPage = await upstreamRequest(fetcher, jar, "/login", {
    headers: { Referer: SITE_ORIGIN + "/login" },
  });
  if (!loginPage.ok) throw new Error("Не удалось открыть страницу входа AnimeGO (HTTP " + loginPage.status + ").");

  let form;
  try {
    form = parseAnimeGoLoginForm(loginPage.text, { baseUrl: loginPage.url });
  } catch {
    throw new Error("AnimeGO изменил форму входа. Авторизация остановлена без отправки данных.");
  }

  const payload = new URLSearchParams({
    [form.usernameField]: username,
    [form.passwordField]: password,
    [form.csrfField]: form.csrfToken,
  });
  if (rememberMe && form.rememberMeField) payload.set(form.rememberMeField, form.rememberMeValue || "on");

  const loginResponse = await upstreamRequest(fetcher, jar, form.action, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SITE_ORIGIN,
      Referer: SITE_ORIGIN + "/login",
    },
  });

  if (loginResponse.status === 403 && /captcha|cloudflare|challenge/i.test(loginResponse.text)) {
    throw new Error("AnimeGO запросил дополнительную проверку. Автоматическая авторизация остановлена.");
  }

  const home = await upstreamRequest(fetcher, jar, "/");
  if (!home.ok) throw new Error("AnimeGO не подтвердил вход (HTTP " + home.status + ").");
  const user = readUserFromHtml(home.text);
  if (!user) {
    if (/captcha|cloudflare|challenge/i.test(home.text)) {
      throw new Error("AnimeGO запросил дополнительную проверку. Автоматическая авторизация остановлена.");
    }
    throw new Error("AnimeGO не подтвердил авторизацию. Проверь логин и пароль.");
  }

  const account = {
    cookies: [...jar.entries()],
    userId: user.id,
    accountLabel: user.label || username.slice(0, 100),
    connectedAt: new Date().toISOString(),
    expiresAt: null,
  };
  await saveStoredAccount(readTokens, writeTokens, account);
  return statusFromAccount(account);
}

export async function disconnectAnimeGoAccount({ readTokens, writeTokens }) {
  await clearStoredAccount(readTokens, writeTokens);
  return statusFromAccount(null);
}

export async function fetchAnimeGoAccountLists({ readTokens, writeTokens, fetcher = fetch, intervalMs = REQUEST_INTERVAL_MS }) {
  const tokens = await readTokens();
  const stored = getStoredAccount(tokens);
  if (!stored) throw new Error("Сначала подключи аккаунт AnimeGO.");

  const account = await validateAccount(fetcher, stored);
  if (!account) {
    await clearStoredAccount(readTokens, writeTokens);
    throw new Error("Сессия AnimeGO истекла. Подключи аккаунт повторно.");
  }
  await saveStoredAccount(readTokens, writeTokens, account);

  const jar = new Map(account.cookies);
  const lists = [];
  const allItems = [];
  const seen = new Set();

  for (let listType = 1; listType <= 6; listType += 1) {
    // Page 1 is embedded in the profile response; later pages are lazy Turbo Frames.
    let pageResult = await upstreamRequest(fetcher, jar,
      "/profile/" + account.userId + "?type=" + listType, {
        headers: { Referer: SITE_ORIGIN + "/" },
      });
    if (pageResult.status === 404) {
      pageResult = await upstreamRequest(fetcher, jar,
        "/user/" + account.userId + "?type=" + listType, {
          headers: { Referer: SITE_ORIGIN + "/" },
        });
    }
    if (!pageResult.ok) throw new Error("AnimeGO не смог открыть профиль со списком (HTTP " + pageResult.status + ").");

    let pageCount = 0;
    let itemCount = 0;

    while (pageResult) {
      if (pageCount >= MAX_PAGES_PER_LIST) {
        throw new Error("AnimeGO: достигнут лимит страниц личного списка.");
      }

      const parsed = parseAnimeGoMyListResponse(pageResult.text, {
        baseUrl: pageResult.url,
        listType,
      });
      pageCount += 1;
      for (const item of parsed.items) {
        itemCount += 1;
        if (seen.has(item.listEntryId)) continue;
        seen.add(item.listEntryId);
        allItems.push(item);
        if (allItems.length > MAX_ITEMS) throw new Error("AnimeGO вернул слишком много записей для одного импорта.");
      }

      if (!parsed.nextPageUrl) {
        pageResult = null;
        continue;
      }

      const nextPageUrl = parsed.nextPageUrl;
      const nextFrameId = parsed.nextPageFrameId;
      pageResult = await withAnimeGoRateLimit(() => upstreamRequest(fetcher, jar, nextPageUrl, {
        headers: {
          Referer: SITE_ORIGIN + "/profile/" + account.userId + "?type=" + listType,
          ...(nextFrameId ? { "Turbo-Frame": nextFrameId } : {}),
        },
      }), intervalMs);
      if (!pageResult.ok) {
        throw new Error("AnimeGO не смог загрузить страницу личного списка (HTTP " + pageResult.status + ").");
      }
    }

    lists.push({ listType, pageCount, itemCount });
  }

  return {
    provider: "animego",
    account: { userId: account.userId, accountLabel: account.accountLabel },
    fetchedAt: new Date().toISOString(),
    lists,
    total: allItems.length,
    items: allItems,
  };
}
