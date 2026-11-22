const API = "https://api.yani.tv";

function unwrap(payload) {
  return payload && typeof payload === "object" && "response" in payload ? payload.response : payload;
}

function safeMessage(payload, fallback) {
  return String(payload?.error_title || payload?.message || payload?.error || fallback);
}

function createApi(applicationToken, token) {
  if (!applicationToken) throw new Error("YUMMY_APPLICATION_TOKEN не настроен в .env.local.");
  return async function request(path, options = {}) {
    const response = await fetch(API + path, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Application": applicationToken,
        Lang: "ru",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal || AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { payload = { message: raw.slice(0, 300) }; }
    if (!response.ok || payload?.error) {
      const error = new Error(safeMessage(payload, "YummyAnime API: HTTP " + response.status));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };
}

function requireId(value, label) {
  const id = String(value || "");
  if (!/^\d+$/.test(id)) throw new Error("Некорректный " + label + " ID.");
  return id;
}

export async function handleYummyAnimeRequest(request, response, url, deps) {
  const { sendJson, readJson, readTokens, writeTokens } = deps;
  const method = request.method || "GET";
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/yummyanime/")) return false;

  const applicationToken = process.env.YUMMY_APPLICATION_TOKEN || "";
  const tokens = await readTokens();
  const account = tokens.yummyanime || null;
  if (method === "GET" && pathname === "/api/yummyanime/status") {
    return sendJson(response, 200, {
      configured: Boolean(applicationToken),
      connected: Boolean(account?.accessToken),
      username: account?.username || null,
      userId: account?.userId || null,
      refreshedAt: account?.refreshedAt || null,
    });
  }

  if (method === "POST" && pathname === "/api/yummyanime/login") {
    if (!applicationToken) return sendJson(response, 400, { error: "Добавь YUMMY_APPLICATION_TOKEN в .env.local." });
    const body = await readJson(request, 8192);
    const login = String(body.login || "").trim();
    const password = String(body.password || "");
    const captcha = String(body.captcha || "").trim();
    if (!login || !password) return sendJson(response, 400, { error: "Укажи логин и пароль YummyAnime." });
    try {
      const loginApi = createApi(applicationToken, null);
      const payload = await loginApi("/profile/login", {
        method: "POST",
        body: { login, password, need_json: true, ...(captcha ? { captcha } : {}) },
      });
      const data = unwrap(payload) || {};
      const accessToken = String(data.token || data.access_token || "");
      if (accessToken.length < 16) throw new Error("YummyAnime не вернул корректный токен авторизации.");
      tokens.yummyanime = {
        accessToken,
        username: login,
        userId: Number(data.id || data.user_id) || null,
        refreshedAt: Date.now(),
      };
      await writeTokens(tokens);
      try {
        const profile = unwrap(await createApi(applicationToken, accessToken)("/profile"));
        if (profile && typeof profile === "object") {
          tokens.yummyanime.username = profile.nickname || profile.login || login;
          tokens.yummyanime.userId = Number(profile.id || profile.user_id) || tokens.yummyanime.userId;
          await writeTokens(tokens);
        }
      } catch {
        // Login is valid even if the optional profile refresh is temporarily unavailable.
      }
      return sendJson(response, 200, { ok: true, username: tokens.yummyanime.username });
    } catch (error) {
      if (error.status === 420) return sendJson(response, 420, {
        error: "YummyAnime требует подтверждение hCaptcha. Повтори вход с captcha response.",
        captchaRequired: true,
        siteKey: "b1847961-208e-4a90-9671-1e6bba9e0b36",
      });
      return sendJson(response, error.status || 502, { error: error.message });
    }
  }

  if (method === "POST" && pathname === "/api/yummyanime/logout") {
    if (account?.accessToken && applicationToken) {
      try { await createApi(applicationToken, account.accessToken)("/profile/logout", { method: "POST" }); } catch {}
    }
    delete tokens.yummyanime;
    await writeTokens(tokens);
    return sendJson(response, 200, { ok: true });
  }

  if (!applicationToken) return sendJson(response, 503, { error: "Добавь YUMMY_APPLICATION_TOKEN в .env.local." });
  const api = createApi(applicationToken, account?.accessToken || null);

  async function authorizedApi() {
    if (!tokens.yummyanime?.accessToken) throw Object.assign(new Error("Аккаунт YummyAnime не подключён."), { status: 401 });
    const current = tokens.yummyanime;
    if (Date.now() - Number(current.refreshedAt || 0) > 2 * 24 * 60 * 60 * 1000) {
      try {
        const refreshed = unwrap(await createApi(applicationToken, current.accessToken)("/profile/token"));
        const refreshedToken = String(refreshed?.token || refreshed?.access_token || "");
        if (refreshedToken.length >= 16) current.accessToken = refreshedToken;
        current.refreshedAt = Date.now();
        await writeTokens(tokens);
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          delete tokens.yummyanime;
          await writeTokens(tokens);
          throw Object.assign(new Error("Сессия YummyAnime истекла. Подключи аккаунт заново."), { status: 401 });
        }
        // Keep the existing token on temporary network/API errors.
      }
    }
    return createApi(applicationToken, current.accessToken);
  }

  if (method === "GET" && pathname === "/api/yummyanime/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 120) return sendJson(response, 400, { error: "Поисковый запрос должен содержать от 2 до 120 символов." });
    const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Math.min(10000, Number(url.searchParams.get("offset")) || 0));
    try {
      return sendJson(response, 200, unwrap(await api("/search?" + new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) }))));
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  const detailMatch = pathname.match(/^\/api\/yummyanime\/anime\/([^/]+)$/);
  if (method === "GET" && detailMatch) {
    try {
      const id = encodeURIComponent(decodeURIComponent(detailMatch[1]));
      const detail = unwrap(await api("/anime/" + id));
      const numericId = requireId(detail?.anime_id || id, "аниме");
      // Video metadata is optional for catalog browsing. Preserve title details
      // and the official page link when a film has no player or the video API stalls.
      let videos = [];
      try {
        videos = unwrap(await api("/anime/" + numericId + "/videos"));
      } catch {
        videos = [];
      }
      return sendJson(response, 200, { detail, videos });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "GET" && pathname === "/api/yummyanime/profile") {
    try {
      const authApi = await authorizedApi();
      const profile = unwrap(await authApi("/profile"));
      return sendJson(response, 200, profile);
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "GET" && pathname === "/api/yummyanime/lists") {
    try {
      const authApi = await authorizedApi();
      const profile = unwrap(await authApi("/profile"));
      const userId = requireId(profile?.id || profile?.user_id || tokens.yummyanime?.userId, "пользователя");
      const definitions = unwrap(await authApi("/users/" + userId + "/lists"));
      if (!Array.isArray(definitions)) throw new Error("YummyAnime вернул списки в неожиданном формате.");
      const rows = [];
      for (const definition of definitions) {
        const listId = Number(definition?.id);
        if (!Number.isSafeInteger(listId) || listId < 0 || listId > 5) continue;
        const page = unwrap(await authApi("/users/" + userId + "/lists/" + listId));
        const pageRows = Array.isArray(page) ? page
          : Array.isArray(page?.data) ? page.data
          : Array.isArray(page?.items) ? page.items
          : null;
        if (!pageRows) throw new Error("YummyAnime вернул страницу списка в неожиданном формате.");
        const listName = String(definition?.name || definition?.title || definition?.label || "");
        rows.push(...pageRows.map((row) => ({
          ...row,
          list_id: row?.list_id ?? listId,
          ...(listName && !row?.list_name ? { list_name: listName } : {}),
        })));
      }
      return sendJson(response, 200, { profile, lists: definitions, entries: rows, count: rows.length });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "GET" && pathname === "/api/yummyanime/history") {
    try {
      const authApi = await authorizedApi();
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const history = unwrap(await authApi("/video/watch-history?" + new URLSearchParams({ limit: String(limit), offset: String(offset) })));
      if (!Array.isArray(history)) throw new Error("YummyAnime вернул историю просмотра в неожиданном формате.");
      return sendJson(response, 200, { entries: history, count: history.length, limit, offset });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "POST" && pathname === "/api/yummyanime/list") {
    try {
      const authApi = await authorizedApi();
      const body = await readJson(request);
      const animeId = requireId(body.animeId, "аниме");
      const listId = Number(body.listId);
      if (![0, 1, 2, 3, 5].includes(listId)) return sendJson(response, 400, { error: "Недопустимый список YummyAnime." });
      const result = unwrap(await authApi("/anime/" + animeId + "/list", { method: "PUT", body: { list: listId } }));
      return sendJson(response, 200, { ok: true, result });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "POST" && pathname === "/api/yummyanime/favorite") {
    try {
      const authApi = await authorizedApi();
      const body = await readJson(request);
      const animeId = requireId(body.animeId, "аниме");
      if (typeof body.favorite !== "boolean") return sendJson(response, 400, { error: "Укажи булево значение favorite." });
      const result = unwrap(await authApi("/anime/" + animeId + "/list/fav", {
        method: body.favorite ? "PUT" : "DELETE",
      }));
      return sendJson(response, 200, { ok: true, result });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  if (method === "POST" && pathname === "/api/yummyanime/progress") {
    try {
      const authApi = await authorizedApi();
      const body = await readJson(request);
      const videoId = requireId(body.videoId, "эпизода");
      const time = Number(body.time);
      const duration = Number(body.duration);
      if (!Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0 || time > duration) {
        return sendJson(response, 400, { error: "Некорректное время просмотра." });
      }
      const result = unwrap(await authApi("/video/" + videoId, { method: "PUT", body: { time, duration, times: [] } }));
      return sendJson(response, 200, { ok: true, result });
    } catch (error) { return sendJson(response, error.status || 502, { error: error.message }); }
  }

  return sendJson(response, 404, { error: "Маршрут YummyAnime не найден." });
}
