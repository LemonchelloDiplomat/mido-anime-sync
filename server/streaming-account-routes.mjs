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

/**
 * Browser-facing account routes expose status only. They intentionally do not
 * accept passwords, cookies, tokens, or arbitrary upstream URLs. Provider
 * authentication must be added as a server-side adapter after its protocol
 * and permission model have been verified.
 */
export async function handleStreamingAccountRequest(request, response, url, { sendJson }) {
  const match = url.pathname.match(/^\/api\/streaming\/accounts\/(animego|anixart)\/(status|disconnect)$/);
  if (!match) return false;

  const [, provider, action] = match;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    sendJson(response, 404, { error: "Неизвестный потоковый сервис." });
    return true;
  }

  if (action === "status" && request.method === "GET") {
    sendProviderStatus(response, sendJson, provider);
    return true;
  }

  if (action === "disconnect" && request.method === "POST") {
    // Idempotent while no server-side provider adapter is registered.
    sendProviderStatus(response, sendJson, provider);
    return true;
  }

  sendJson(response, 405, { error: "Метод не поддерживается." });
  return true;
}
