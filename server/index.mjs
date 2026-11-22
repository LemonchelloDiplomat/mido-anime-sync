import { createServer } from "node:http";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { toMyAnimeListScore } from "./mal-score.mjs";
import { handleMalDelete } from "./mal-delete-route.mjs";
import { handleYummyAnimeRequest } from "./yummyanime-routes.mjs";
import { handleAnimeGoRequest } from "./animego-routes.mjs";
import { handleAnixArtRequest } from "./anixart-routes.mjs";
import { fetchAniListAnimeList } from "./anilist-list.mjs";
import { enrichShikimoriAnimeRates } from "./shikimori-enrichment.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, ".local-data");
const TOKEN_FILE = path.join(DATA_DIR, "tokens.enc.json");
const KEY_FILE = path.join(DATA_DIR, "local.key");
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const MAL_API = "https://api.myanimelist.net/v2";
const MAL_OAUTH = "https://myanimelist.net/v1/oauth2";
const ANILIST_GRAPHQL = "https://graphql.anilist.co";
const SHIKIMORI_API = "https://shikimori.io/api";
const SHIKIMORI_OAUTH = "https://shikimori.io/oauth";
let shikimoriQueue = Promise.resolve();
let shikimoriLastRequestAt = 0;
let shikimoriRequestStarts = [];

async function acquireShikimoriRequestSlot() {
  const previous = shikimoriQueue;
  let release;
  shikimoriQueue = new Promise((resolve) => { release = resolve; });
  await previous;

  try {
    let now = Date.now();
    shikimoriRequestStarts = shikimoriRequestStarts.filter((startedAt) => now - startedAt < 60000);
    const spacingDelay = Math.max(0, shikimoriLastRequestAt + 220 - now);
    const minuteDelay = shikimoriRequestStarts.length >= 80
      ? Math.max(0, shikimoriRequestStarts[0] + 60000 - now)
      : 0;
    const delay = Math.max(spacingDelay, minuteDelay);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    now = Date.now();
    shikimoriLastRequestAt = now;
    shikimoriRequestStarts.push(now);
  } finally {
    release();
  }
}

const sessions = new Map();

async function loadLocalEnv() {
  try {
    const content = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function getEncryptionKey() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const key = await fs.readFile(KEY_FILE);
    if (key.length !== 32) throw new Error("Локальный ключ шифрования повреждён. Удали .local-data/local.key и подключи аккаунты заново.");
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = randomBytes(32);
    await fs.writeFile(KEY_FILE, key, { mode: 0o600, flag: "wx" });
    try { await fs.chmod(KEY_FILE, 0o600); } catch {}
    return key;
  }
}

async function readTokens() {
  try {
    const envelope = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
    if (envelope.version !== 1) throw new Error("Unknown token store version");
    const key = await getEncryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Не удалось прочитать зашифрованные токены. Проверь папку .local-data.");
  }
}

async function writeTokens(tokens) {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const envelope = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
  const temporary = TOKEN_FILE + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  await fs.rename(temporary, TOKEN_FILE);
  try { await fs.chmod(TOKEN_FILE, 0o600); } catch {}
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

async function readJson(request, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Слишком большой запрос.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = payload?.message || payload?.error_description || payload?.error || ("HTTP " + response.status);
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }
  return payload;
}

function getRedirectUri(provider) {
  const configured = provider === "mal" ? process.env.MAL_REDIRECT_URI
    : provider === "anilist" ? process.env.ANILIST_REDIRECT_URI
    : process.env.SHIKIMORI_REDIRECT_URI;
  return configured || ("http://127.0.0.1:" + PORT + "/api/auth/" + provider + "/callback");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function exchangeMalCode(code, verifier, redirectUri) {
  const form = new URLSearchParams({
    client_id: process.env.MAL_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  if (process.env.MAL_CLIENT_SECRET) form.set("client_secret", process.env.MAL_CLIENT_SECRET);
  return fetchJson(MAL_OAUTH + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function getMalAccessToken(tokens) {
  const mal = tokens.mal;
  if (!mal?.accessToken) throw new Error("MyAnimeList ещё не подключён.");
  if (Number(mal.expiresAt) > Date.now() + 60000) return mal.accessToken;
  if (!mal.refreshToken) throw new Error("Сессия MyAnimeList истекла. Подключи аккаунт заново.");
  const form = new URLSearchParams({
    client_id: process.env.MAL_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: mal.refreshToken,
  });
  if (process.env.MAL_CLIENT_SECRET) form.set("client_secret", process.env.MAL_CLIENT_SECRET);
  const refreshed = await fetchJson(MAL_OAUTH + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  tokens.mal = {
    ...mal,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || mal.refreshToken,
    expiresAt: Date.now() + Number(refreshed.expires_in || 0) * 1000,
  };
  await writeTokens(tokens);
  return tokens.mal.accessToken;
}

async function malRequest(url, tokens) {
  const accessToken = await getMalAccessToken(tokens);
  return fetchJson(url, {
    headers: {
      "X-MAL-CLIENT-ID": process.env.MAL_CLIENT_ID,
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
    },
  });
}

async function exchangeShikimoriToken(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return fetchJson(SHIKIMORI_OAUTH + "/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "User-Agent": process.env.SHIKIMORI_USER_AGENT || "mido-anime-sync/0.5.0",
    },
    body: form,
  });
}

async function getShikimoriAccessToken(tokens) {
  const shikimori = tokens.shikimori;
  if (!shikimori?.accessToken) throw new Error("Shikimori ещё не подключён.");
  if (Number(shikimori.expiresAt) > Date.now() + 60000) return shikimori.accessToken;
  if (!shikimori.refreshToken) throw new Error("Сессия Shikimori истекла. Подключи аккаунт заново.");

  const refreshed = await exchangeShikimoriToken({
    grant_type: "refresh_token",
    client_id: process.env.SHIKIMORI_CLIENT_ID,
    client_secret: process.env.SHIKIMORI_CLIENT_SECRET,
    refresh_token: shikimori.refreshToken,
  });
  const accessToken = String(refreshed.access_token || "");
  const expiresIn = Number(refreshed.expires_in);
  if (accessToken.length < 20 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Shikimori вернул некорректный ответ при обновлении токена.");
  }
  tokens.shikimori = {
    ...shikimori,
    accessToken,
    refreshToken: refreshed.refresh_token || shikimori.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  await writeTokens(tokens);
  return accessToken;
}

async function shikimoriRequest(pathname, tokens, options = {}) {
  const accessToken = await getShikimoriAccessToken(tokens);
  await acquireShikimoriRequestSlot();
  return fetchJson(SHIKIMORI_API + pathname, {
    ...options,
    headers: {
      "User-Agent": process.env.SHIKIMORI_USER_AGENT || "mido-anime-sync/0.5.0",
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

async function anilistRequest(query, variables, token) {
  const payload = await fetchJson(ANILIST_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length) throw new Error(payload.errors[0]?.message || "Ошибка AniList GraphQL.");
  return payload.data;
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://" + (request.headers.host || "127.0.0.1"));
  const method = request.method || "GET";

  if (url.pathname.startsWith("/api/yummyanime/")) {
    return handleYummyAnimeRequest(request, response, url, { sendJson, readJson, readTokens, writeTokens });
  }
  if (url.pathname.startsWith("/api/animego/")) {
    return handleAnimeGoRequest(request, response, url, { sendJson });
  }
  if (url.pathname.startsWith("/api/anixart/")) {
    return handleAnixArtRequest(request, response, url, { sendJson, readJson });
  }

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, mode: "local", apiVersion: 1 });
  }

  if (method === "GET" && url.pathname === "/api/integrations/status") {
    const tokens = await readTokens();
    return sendJson(response, 200, {
      server: { ok: true, mode: "local" },
      myanimelist: {
        configured: Boolean(process.env.MAL_CLIENT_ID),
        connected: Boolean(tokens.mal?.refreshToken || tokens.mal?.accessToken),
        username: tokens.mal?.username || null,
      },
      anilist: {
        configured: Boolean(process.env.ANILIST_CLIENT_ID && process.env.ANILIST_CLIENT_SECRET),
        connected: Boolean(tokens.anilist?.accessToken && tokens.anilist.expiresAt > Date.now()),
        username: tokens.anilist?.username || null,
        expiresAt: tokens.anilist?.expiresAt || null,
      },
      shikimori: {
        configured: Boolean(process.env.SHIKIMORI_CLIENT_ID && process.env.SHIKIMORI_CLIENT_SECRET),
        connected: Boolean(tokens.shikimori?.refreshToken || tokens.shikimori?.accessToken),
        username: tokens.shikimori?.username || null,
        expiresAt: tokens.shikimori?.expiresAt || null,
      },
    });
  }

  if (method === "GET" && url.pathname === "/api/auth/mal/start") {
    if (!process.env.MAL_CLIENT_ID) return sendJson(response, 400, { error: "Сначала добавь MAL_CLIENT_ID в .env.local." });
    const state = randomBytes(24).toString("hex");
    const verifier = randomBytes(48).toString("base64url").slice(0, 64);
    const redirectUri = getRedirectUri("mal");
    sessions.set("mal:" + state, { verifier, redirectUri, expiresAt: Date.now() + 600000 });
    const authorize = new URL(MAL_OAUTH + "/authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", process.env.MAL_CLIENT_ID);
    authorize.searchParams.set("code_challenge", verifier);
    authorize.searchParams.set("code_challenge_method", "plain");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("redirect_uri", redirectUri);
    response.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" });
    return response.end();
  }

  if (method === "GET" && url.pathname === "/api/auth/mal/callback") {
    const state = url.searchParams.get("state") || "";
    const pending = sessions.get("mal:" + state);
    sessions.delete("mal:" + state);
    if (!pending || pending.expiresAt < Date.now()) {
      return sendHtml(response, 400, "<h2>Авторизация MyAnimeList не завершена</h2><p>Состояние авторизации устарело. Повтори подключение из приложения.</p><a href='/'>Вернуться</a>");
    }
    if (url.searchParams.has("error")) {
      return sendHtml(response, 400, "<h2>MyAnimeList отклонил подключение</h2><p>" + escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error")) + "</p><a href='/'>Вернуться</a>");
    }
    const code = url.searchParams.get("code");
    if (!code) return sendHtml(response, 400, "<h2>MyAnimeList не вернул код авторизации.</h2><a href='/'>Вернуться</a>");
    try {
      const token = await exchangeMalCode(code, pending.verifier, pending.redirectUri);
      const tokens = await readTokens();
      tokens.mal = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in || 0) * 1000,
        username: null,
        userId: null,
      };
      await writeTokens(tokens);
      const me = await malRequest(MAL_API + "/users/@me", tokens);
      tokens.mal.username = me.name || null;
      tokens.mal.userId = me.id || null;
      await writeTokens(tokens);
      return sendHtml(response, 200, "<h2>MyAnimeList подключён ✓</h2><p>Токен сохранён в зашифрованном локальном хранилище.</p><a href='/'>Вернуться в mido-anime-sync</a>");
    } catch (error) {
      return sendHtml(response, 502, "<h2>Не удалось подключить MyAnimeList</h2><p>" + escapeHtml(error.message) + "</p><a href='/'>Вернуться</a>");
    }
  }

  if (method === "GET" && url.pathname === "/api/auth/anilist/start") {
    if (!process.env.ANILIST_CLIENT_ID || !process.env.ANILIST_CLIENT_SECRET) {
      return sendJson(response, 400, { error: "Сначала добавь ANILIST_CLIENT_ID и ANILIST_CLIENT_SECRET в .env.local." });
    }
    const state = randomBytes(24).toString("hex");
    const redirectUri = getRedirectUri("anilist");
    sessions.set("anilist:" + state, { redirectUri, expiresAt: Date.now() + 600000 });
    const authorize = new URL("https://anilist.co/api/v2/oauth/authorize");
    authorize.searchParams.set("client_id", process.env.ANILIST_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("state", state);
    response.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" });
    return response.end();
  }

  if (method === "GET" && url.pathname === "/api/auth/anilist/callback") {
    const html = await fs.readFile(path.join(ROOT, "public", "anilist-oauth-callback.html"), "utf8");
    return sendHtml(response, 200, html);
  }

  if (method === "POST" && url.pathname === "/api/auth/anilist/token") {
    const body = await readJson(request);
    const state = String(body.state || "");
    const pending = sessions.get("anilist:" + state);
    sessions.delete("anilist:" + state);
    if (!pending || pending.expiresAt < Date.now()) {
      return sendJson(response, 400, { error: "Состояние авторизации AniList устарело. Повтори подключение." });
    }
    const code = String(body.code || "");
    if (!code || !process.env.ANILIST_CLIENT_ID || !process.env.ANILIST_CLIENT_SECRET) {
      return sendJson(response, 400, { error: "Не хватает кода авторизации или настроек AniList в .env.local." });
    }
    try {
      const token = await fetchJson("https://anilist.co/api/v2/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: process.env.ANILIST_CLIENT_ID,
          client_secret: process.env.ANILIST_CLIENT_SECRET,
          redirect_uri: pending.redirectUri,
          code,
        }),
      });
      const accessToken = String(token.access_token || "");
      const expiresIn = Number(token.expires_in);
      if (accessToken.length < 20 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        return sendJson(response, 502, { error: "AniList вернул некорректный ответ при обмене кода на токен." });
      }
      const data = await anilistRequest("query { Viewer { id name mediaListOptions { scoreFormat } } }", {}, accessToken);
      const tokens = await readTokens();
      tokens.anilist = {
        accessToken,
        expiresAt: Date.now() + expiresIn * 1000,
        username: data.Viewer.name,
        userId: data.Viewer.id,
        scoreFormat: data.Viewer.mediaListOptions?.scoreFormat || "POINT_100",
      };
      await writeTokens(tokens);
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, error.status || 401, { error: "Не удалось подключить AniList: " + error.message });
    }
  }

  if (method === "GET" && url.pathname === "/api/auth/shikimori/start") {
    if (!process.env.SHIKIMORI_CLIENT_ID || !process.env.SHIKIMORI_CLIENT_SECRET) {
      return sendJson(response, 400, { error: "Сначала добавь SHIKIMORI_CLIENT_ID и SHIKIMORI_CLIENT_SECRET в .env.local." });
    }
    const state = randomBytes(24).toString("hex");
    const redirectUri = getRedirectUri("shikimori");
    sessions.set("shikimori:" + state, { redirectUri, expiresAt: Date.now() + 600000 });
    const authorize = new URL(SHIKIMORI_OAUTH + "/authorize");
    authorize.searchParams.set("client_id", process.env.SHIKIMORI_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "user_rates");
    authorize.searchParams.set("state", state);
    response.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" });
    return response.end();
  }

  if (method === "GET" && url.pathname === "/api/auth/shikimori/callback") {
    const state = url.searchParams.get("state") || "";
    const pending = sessions.get("shikimori:" + state);
    sessions.delete("shikimori:" + state);
    if (!pending || pending.expiresAt < Date.now()) {
      return sendHtml(response, 400, "<h2>Авторизация Shikimori не завершена</h2><p>Состояние авторизации устарело. Повтори подключение из приложения.</p><a href='/'>Вернуться</a>");
    }
    if (url.searchParams.has("error")) {
      return sendHtml(response, 400, "<h2>Shikimori отклонил подключение</h2><p>" + escapeHtml(url.searchParams.get("error_description") || url.searchParams.get("error")) + "</p><a href='/'>Вернуться</a>");
    }
    const code = url.searchParams.get("code");
    if (!code) return sendHtml(response, 400, "<h2>Shikimori не вернул код авторизации.</h2><a href='/'>Вернуться</a>");
    try {
      const token = await exchangeShikimoriToken({
        grant_type: "authorization_code",
        client_id: process.env.SHIKIMORI_CLIENT_ID,
        client_secret: process.env.SHIKIMORI_CLIENT_SECRET,
        code,
        redirect_uri: pending.redirectUri,
      });
      const accessToken = String(token.access_token || "");
      const expiresIn = Number(token.expires_in);
      const refreshToken = String(token.refresh_token || "");
      if (accessToken.length < 20 || refreshToken.length < 10 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("Shikimori вернул некорректный ответ при авторизации.");
      }
      const tokens = await readTokens();
      tokens.shikimori = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        username: null,
        userId: null,
      };
      const me = await shikimoriRequest("/users/whoami", tokens);
      tokens.shikimori.username = me.nickname || me.name || null;
      tokens.shikimori.userId = me.id || null;
      await writeTokens(tokens);
      return sendHtml(response, 200, "<h2>Shikimori подключён ✓</h2><p>Токены сохранены в зашифрованном локальном хранилище.</p><a href='/'>Вернуться в mido-anime-sync</a>");
    } catch (error) {
      return sendHtml(response, 502, "<h2>Не удалось подключить Shikimori</h2><p>" + escapeHtml(error.message) + "</p><a href='/'>Вернуться</a>");
    }
  }

  if (method === "POST" && url.pathname === "/api/integrations/disconnect") {
    const body = await readJson(request);
    const provider = body.provider;
    if (provider !== "mal" && provider !== "anilist" && provider !== "shikimori") return sendJson(response, 400, { error: "Неизвестный сервис." });
    const tokens = await readTokens();
    delete tokens[provider];
    await writeTokens(tokens);
    return sendJson(response, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/mal/list") {
    if (!process.env.MAL_CLIENT_ID) return sendJson(response, 400, { error: "MyAnimeList API не настроен." });
    const tokens = await readTokens();
    try {
      let next = MAL_API + "/users/@me/animelist?fields=list_status,alternative_titles,start_date,media_type,status,num_episodes,mean,genres,rating&limit=1000&nsfw=true";
      const items = [];
      let pages = 0;
      while (next && pages < 100) {
        const parsed = new URL(next);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "api.myanimelist.net" ||
          (parsed.port && parsed.port !== "443") ||
          parsed.username ||
          parsed.password ||
          !parsed.pathname.startsWith("/v2/users/")
        ) {
          throw new Error("MyAnimeList вернул недопустимую ссылку пагинации.");
        }
        const page = await malRequest(parsed.toString(), tokens);
        if (!page || !Array.isArray(page.data)) {
          throw new Error("MyAnimeList вернул некорректную страницу списка.");
        }
        items.push(...page.data);
        const nextPage = page.paging?.next;
        if (nextPage != null && typeof nextPage !== "string") {
          throw new Error("MyAnimeList вернул некорректный указатель следующей страницы.");
        }
        next = nextPage || null;
        pages += 1;
      }
      if (next) throw new Error("Список MyAnimeList слишком большой: достигнут лимит страниц.");
      return sendJson(response, 200, { data: items, count: items.length });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/mal/entry") {
    const body = await readJson(request);
    const id = Number(body.externalId);
    const status = String(body.status || "");
    const progress = Number(body.progress);
    const score = body.score == null ? 0 : Number(body.score);
    const statuses = ["PLANNING", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED", "REWATCHING"];
    if (!Number.isSafeInteger(id) || id <= 0 || !statuses.includes(status) ||
        !Number.isSafeInteger(progress) || progress < 0 ||
        !Number.isFinite(score) || score < 0 || score > 100) {
      return sendJson(response, 400, { error: "Некорректные данные записи для MyAnimeList." });
    }
    const malStatus = status === "PLANNING" ? "plan_to_watch"
      : status === "WATCHING" || status === "REWATCHING" ? "watching"
      : status === "COMPLETED" ? "completed"
      : status === "ON_HOLD" ? "on_hold" : "dropped";
    const form = new URLSearchParams({
      status: malStatus,
      score: String(toMyAnimeListScore(score)),
      num_watched_episodes: String(progress),
      is_rewatching: status === "REWATCHING" ? "true" : "false",
    });
    // Preserve metadata already stored on MAL. Never copy another provider's
    // metadata into this endpoint: the client sends the MAL baseline only.
    const malMetadata = body.sourceMetadata && typeof body.sourceMetadata === "object"
      ? body.sourceMetadata : {};
    for (const [key, field] of [
      ["num_times_rewatched", "timesRewatched"],
      ["rewatch_value", "rewatchValue"],
      ["priority", "priority"],
    ]) {
      const value = Number(malMetadata[field]);
      const max = key === "rewatch_value" ? 5 : key === "priority" ? 2 : Number.MAX_SAFE_INTEGER;
      if (Number.isSafeInteger(value) && value >= 0 && value <= max) form.set(key, String(value));
    }
    if (Array.isArray(malMetadata.tags) &&
        malMetadata.tags.every((tag) => typeof tag === "string" && tag.length <= 100)) {
      form.set("tags", malMetadata.tags.join(","));
    }
    if (typeof malMetadata.comments === "string") form.set("comments", malMetadata.comments.slice(0, 2000));
    for (const [key, field] of [["start_date", "startDate"], ["finish_date", "finishDate"]]) {
      const value = malMetadata[field];
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) form.set(key, value);
    }
    try {
      const tokens = await readTokens();
      const accessToken = await getMalAccessToken(tokens);
      const result = await fetchJson(MAL_API + "/anime/" + id + "/my_list_status", {
        method: "PUT",
        headers: {
          "X-MAL-CLIENT-ID": process.env.MAL_CLIENT_ID,
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form,
      });
      return sendJson(response, 200, { ok: true, result });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/mal/entry/delete") {
    const body = await readJson(request);
    const result = await handleMalDelete(body, {
      readTokens,
      getAccessToken: getMalAccessToken,
      clientId: process.env.MAL_CLIENT_ID,
      requestJson: fetchJson,
    });
    return sendJson(response, result.status, result.body);
  }

  if (method === "GET" && url.pathname === "/api/anilist/list") {
    const tokens = await readTokens();
    if (!tokens.anilist?.accessToken) return sendJson(response, 401, { error: "AniList ещё не подключён." });
    try {
      const { lists, scoreFormat, count } = await fetchAniListAnimeList({
        request: anilistRequest,
        userId: tokens.anilist.userId,
        accessToken: tokens.anilist.accessToken,
      });
      const entries = lists.flatMap((list) => list.entries);
      if (tokens.anilist.scoreFormat !== scoreFormat) {
        tokens.anilist.scoreFormat = scoreFormat;
        await writeTokens(tokens);
      }
      return sendJson(response, 200, { lists, data: entries, count, scoreFormat });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/anilist/entry") {
    const body = await readJson(request);
    const id = Number(body.externalId);
    const status = String(body.status || "");
    const progress = Number(body.progress);
    const score = body.score == null ? 0 : Number(body.score);
    const statuses = ["PLANNING", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED", "REWATCHING"];
    if (!Number.isSafeInteger(id) || id <= 0 || !statuses.includes(status) ||
        !Number.isSafeInteger(progress) || progress < 0 ||
        !Number.isFinite(score) || score < 0 || score > 100) {
      return sendJson(response, 400, { error: "Некорректные данные записи для AniList." });
    }
    const tokens = await readTokens();
    if (!tokens.anilist?.accessToken) return sendJson(response, 401, { error: "AniList ещё не подключён." });
    const format = tokens.anilist.scoreFormat || "POINT_100";
    const remoteScore = score === 0 ? 0
      : format === "POINT_100" ? score
      : format === "POINT_10" || format === "POINT_10_DECIMAL" ? score / 10
      : format === "POINT_5" ? score / 20
      : format === "POINT_3" ? (score / 100) * 3
      : score;
    const remoteStatus = status === "WATCHING" ? "CURRENT"
      : status === "COMPLETED" ? "COMPLETED"
      : status === "ON_HOLD" ? "PAUSED"
      : status === "DROPPED" ? "DROPPED"
      : status === "REWATCHING" ? "REPEATING" : "PLANNING";
    const aniMetadata = body.sourceMetadata && typeof body.sourceMetadata === "object"
      ? body.sourceMetadata : {};
    const repeat = Number(aniMetadata.repeat);
    const notes = typeof aniMetadata.notes === "string" ? aniMetadata.notes.slice(0, 6000) : "";
    const toFuzzyDate = (value) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const [year, month, day] = value.split("-").map(Number);
      return { year, month, day };
    };
    const startedAt = toFuzzyDate(aniMetadata.startedAt);
    const completedAt = toFuzzyDate(aniMetadata.completedAt);
    const mutation = "mutation SaveEntry($mediaId: Int!, $status: MediaListStatus!, $score: Float!, $progress: Int!, $repeat: Int!, $notes: String, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) { SaveMediaListEntry(mediaId: $mediaId, status: $status, score: $score, progress: $progress, repeat: $repeat, notes: $notes, startedAt: $startedAt, completedAt: $completedAt) { id status score progress repeat notes updatedAt startedAt { year month day } completedAt { year month day } } }";
    try {
      const data = await anilistRequest(mutation, {
        mediaId: id,
        status: remoteStatus,
        score: remoteScore,
        progress,
        repeat: Number.isSafeInteger(repeat) && repeat >= 0 ? Math.min(1000, repeat) : 0,
        notes,
        startedAt,
        completedAt,
      }, tokens.anilist.accessToken);

      // AniList favorites are media-level, separate from list-entry fields.
      // Read the current value before toggling so retries remain idempotent.
      if (typeof body.favorite === "boolean") {
        const current = await anilistRequest(
          "query CurrentFavourite($mediaId: Int!) { Media(id: $mediaId) { isFavourite } }",
          { mediaId: id },
          tokens.anilist.accessToken,
        );
        if (Boolean(current.Media?.isFavourite) !== body.favorite) {
          await anilistRequest(
            "mutation SetFavourite($animeId: Int!) { ToggleFavourite(animeId: $animeId) { anime { nodes { id } } } }",
            { animeId: id },
            tokens.anilist.accessToken,
          );
        }
      }
      return sendJson(response, 200, { ok: true, result: data.SaveMediaListEntry });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/anilist/entry/delete") {
    const body = await readJson(request);
    const entryId = Number(body.entryId);
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      return sendJson(response, 400, { error: "Некорректный AniList entry ID для удаления." });
    }
    const tokens = await readTokens();
    if (!tokens.anilist?.accessToken) {
      return sendJson(response, 401, { error: "AniList ещё не подключён." });
    }
    try {
      const data = await anilistRequest(
        "mutation DeleteEntry($id: Int!) { DeleteMediaListEntry(id: $id) { deleted } }",
        { id: entryId },
        tokens.anilist.accessToken,
      );
      if (typeof data.DeleteMediaListEntry?.deleted !== "boolean") {
        throw new Error("AniList вернул некорректный ответ при удалении записи.");
      }
      // A false result means the entry was already absent, so the delete is idempotently complete.
      return sendJson(response, 200, { ok: true, deleted: data.DeleteMediaListEntry.deleted });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "GET" && url.pathname === "/api/shikimori/list") {
    const tokens = await readTokens();
    if (!tokens.shikimori?.accessToken) return sendJson(response, 401, { error: "Shikimori ещё не подключён." });
    try {
      if (!tokens.shikimori.userId) {
        const me = await shikimoriRequest("/users/whoami", tokens);
        tokens.shikimori.userId = me.id || null;
        tokens.shikimori.username = me.nickname || me.name || tokens.shikimori.username || null;
        await writeTokens(tokens);
      }
      if (!tokens.shikimori.userId) throw new Error("Shikimori не вернул ID текущего пользователя.");
      const items = [];
      const limit = 5000;
      let page = 1;
      while (page <= 100) {
        const query = new URLSearchParams({ limit: String(limit), page: String(page) });
        const result = await shikimoriRequest(
          "/users/" + encodeURIComponent(String(tokens.shikimori.userId)) + "/anime_rates?" + query.toString(),
          tokens,
        );
        if (!Array.isArray(result)) throw new Error("Shikimori вернул список в неожиданном формате.");
        items.push(...result);
        if (result.length < limit) break;
        page += 1;
      }
      if (page > 100) throw new Error("Список Shikimori слишком большой: достигнут лимит страниц.");
      const enrichedItems = await enrichShikimoriAnimeRates(
        items,
        (ids) => shikimoriRequest("/animes?ids=" + ids.join(","), tokens),
        (id) => shikimoriRequest("/animes/" + id, tokens),
      );
      return sendJson(response, 200, { data: enrichedItems, count: enrichedItems.length });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/shikimori/entry") {
    const body = await readJson(request);
    const targetId = Number(body.externalId);
    const entryId = body.entryId == null ? null : Number(body.entryId);
    const status = String(body.status || "");
    const progress = Number(body.progress);
    const score = body.score == null ? 0 : Number(body.score);
    const statuses = ["PLANNING", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED", "REWATCHING"];
    if (!Number.isSafeInteger(targetId) || targetId <= 0 ||
        (entryId !== null && (!Number.isSafeInteger(entryId) || entryId <= 0)) ||
        !statuses.includes(status) ||
        !Number.isSafeInteger(progress) || progress < 0 ||
        !Number.isFinite(score) || score < 0 || score > 100) {
      return sendJson(response, 400, { error: "Некорректные данные записи для Shikimori." });
    }
    const tokens = await readTokens();
    if (!tokens.shikimori?.accessToken) return sendJson(response, 401, { error: "Shikimori ещё не подключён." });
    try {
      if (!tokens.shikimori.userId) {
        const me = await shikimoriRequest("/users/whoami", tokens);
        tokens.shikimori.userId = me.id || null;
        await writeTokens(tokens);
      }
      if (!tokens.shikimori.userId) throw new Error("Shikimori не вернул ID текущего пользователя.");
      const remoteStatus = status === "PLANNING" ? "planned"
        : status === "WATCHING" ? "watching"
        : status === "REWATCHING" ? "rewatching"
        : status === "COMPLETED" ? "completed"
        : status === "ON_HOLD" ? "on_hold" : "dropped";
      const userRate = {
        target_id: targetId,
        target_type: "Anime",
        status: remoteStatus,
        score: score === 0 ? 0 : Math.max(1, Math.min(10, Math.round(score / 10))),
        episodes: progress,
        ...(Number.isSafeInteger(Number(body.sourceMetadata?.rewatches)) && Number(body.sourceMetadata.rewatches) >= 0
          ? { rewatches: Number(body.sourceMetadata.rewatches) } : {}),
        ...(typeof body.sourceMetadata?.text === "string"
          ? { text: body.sourceMetadata.text.slice(0, 10000) } : {}),
        ...(entryId === null ? { user_id: tokens.shikimori.userId } : {}),
      };
      const result = entryId === null
        ? await shikimoriRequest("/v2/user_rates", tokens, {
            method: "POST",
            body: JSON.stringify({ user_rate: userRate }),
          })
        : await shikimoriRequest("/v2/user_rates/" + entryId, tokens, {
            method: "PATCH",
            body: JSON.stringify({ user_rate: userRate }),
          });
      return sendJson(response, 200, { ok: true, result });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/shikimori/entry/delete") {
    const body = await readJson(request);
    const entryId = Number(body.entryId);
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      return sendJson(response, 400, { error: "Некорректный Shikimori rate ID для удаления." });
    }
    const tokens = await readTokens();
    if (!tokens.shikimori?.accessToken) return sendJson(response, 401, { error: "Shikimori ещё не подключён." });
    try {
      await shikimoriRequest("/v2/user_rates/" + entryId, tokens, { method: "DELETE" });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    const dist = path.join(ROOT, "dist");
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = path.resolve(dist, "." + requested);
    if (target !== dist && !target.startsWith(dist + path.sep)) return sendJson(response, 400, { error: "Недопустимый путь." });
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("not a file");
      const ext = path.extname(target).toLowerCase();
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
      response.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      return response.end(await fs.readFile(target));
    } catch {
      if (path.extname(requested)) return sendJson(response, 404, { error: "Файл не найден." });
      try {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(await fs.readFile(path.join(dist, "index.html")));
      } catch {
        return sendJson(response, 404, { error: "Сначала выполни npm run build." });
      }
    }
  }

  return sendJson(response, 404, { error: "Маршрут не найден." });
}

await loadLocalEnv();
const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("[api]", error);
    if (!response.headersSent) sendJson(response, 500, { error: error.message || "Внутренняя ошибка сервера." });
    else response.destroy();
  });
});
server.listen(PORT, HOST, () => {
  console.log("mido-anime-sync API: http://" + HOST + ":" + PORT);
  console.log("MyAnimeList: " + (process.env.MAL_CLIENT_ID ? "configured" : "not configured"));
  console.log("AniList: " + (process.env.ANILIST_CLIENT_ID ? "configured" : "not configured"));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
