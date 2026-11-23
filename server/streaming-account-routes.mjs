import {
  connectAnimeGoAccount,
  disconnectAnimeGoAccount,
  fetchAnimeGoAccountLists,
  getAnimeGoAccountStatus,
} from "./animego-account-service.mjs";

const SUPPORTED_PROVIDERS = new Set(["animego", "anixart"]);

function unsupportedStatus(provider) {
  return {
    provider,
    connected: false,
    connectedAt: null,
    expiresAt: null,
    accountLabel: null,
    state: "unsupported",
    errorMessage: null,
  };
}

function sendProviderStatus(response, sendJson, provider) {
  return sendJson(response, 200, {
    provider,
    adapterAvailable: false,
    status: unsupportedStatus(provider),
  });
}

function isLoopbackOrigin(request) {
  const origin = request.headers?.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Local API routes for streaming account sessions. AnimeGO credentials are
 * accepted only by this loopback API and are never returned or persisted.
 * Anixart remains disabled until a permitted authentication contract exists.
 */
export async function handleStreamingAccountRequest(request, response, url, deps) {
  const match = url.pathname.match(/^\/api\/streaming\/accounts\/(animego|anixart)\/(status|connect|disconnect|list)$/);
  if (!match) return false;

  const [, provider, action] = match;
  const { sendJson } = deps;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    sendJson(response, 404, { error: "Неизвестный потоковый сервис." });
    return true;
  }

  if (!isLoopbackOrigin(request)) {
    sendJson(response, 403, { error: "Локальный API принимает подключения только от локального приложения." });
    return true;
  }

  if (provider === "anixart") {
    if (action === "status" && request.method === "GET") {
      sendProviderStatus(response, sendJson, provider);
      return true;
    }
    if (action === "disconnect" && request.method === "POST") {
      sendProviderStatus(response, sendJson, provider);
      return true;
    }
    sendJson(response, 501, { error: "Авторизация Anixart не включена: разрешённый API подключения не подтверждён." });
    return true;
  }

  const serviceDeps = {
    readTokens: deps.readTokens,
    writeTokens: deps.writeTokens,
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
  };

  if (action === "status" && request.method === "GET") {
    const result = await getAnimeGoAccountStatus(serviceDeps);
    sendJson(response, 200, result);
    return true;
  }

  if (action === "connect" && request.method === "POST") {
    if (!deps.readJson || !deps.readTokens || !deps.writeTokens) {
      sendJson(response, 503, { error: "Сервис хранения локальных аккаунтов недоступен." });
      return true;
    }
    let input;
    try {
      input = await deps.readJson(request, 8192);
    } catch {
      sendJson(response, 400, { error: "Не удалось прочитать данные формы подключения." });
      return true;
    }
    try {
      const result = await connectAnimeGoAccount(input, serviceDeps);
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /Укажи логин и пароль/.test(message) ? 400 : 502;
      sendJson(response, status, { error: message || "Не удалось подключить AnimeGO." });
    }
    return true;
  }

  if (action === "disconnect" && request.method === "POST") {
    const result = await disconnectAnimeGoAccount(serviceDeps);
    sendJson(response, 200, result);
    return true;
  }

  if (action === "list" && request.method === "GET") {
    try {
      const result = await fetchAnimeGoAccountLists(serviceDeps);
      sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /Сначала подключи|Сессия AnimeGO истекла/.test(message) ? 401 : 502;
      sendJson(response, status, { error: message || "Не удалось получить список AnimeGO." });
    }
    return true;
  }

  sendJson(response, 405, { error: "Метод не поддерживается." });
  return true;
}
