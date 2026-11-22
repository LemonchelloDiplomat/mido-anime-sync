const QUEUE_KEY = "pendingWatchEvents";
const TOOLBAR_STATE_KEY = "toolbarWatchState";

let toolbarMutationQueue = Promise.resolve();

function enqueueToolbarMutation(operation) {
  const next = toolbarMutationQueue.then(operation, operation);
  // A failed storage/API operation must not poison the queue or create an
  // unhandled rejection from a fire-and-forget Chrome event listener.
  toolbarMutationQueue = next.catch((error) => {
    console.warn("mido-anime-sync background operation failed", error);
  });
  return toolbarMutationQueue;
}

function allowedSourceUrl(service, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (service === "animego") {
    return host === "anime-go.org" || host.endsWith(".anime-go.org") ||
      host === "animego.online" || host.endsWith(".animego.online") ||
      host === "animego.me" || host.endsWith(".animego.me");
  }
  if (service === "yummyanime") {
    return host === "yummyani.me" || host.endsWith(".yummyani.me") ||
      host === "yummy-ani.me" || host.endsWith(".yummy-ani.me");
  }
  if (service === "anixart") {
    return host === "anixart.site" || host.endsWith(".anixart.site");
  }
  return false;
}

function normalizeTitle(title) {
  return String(title || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function normalizeSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    // YummyAnime uses regional and legacy subdomains for the same catalogue.
    // Treat them as one source so the same pending episode is not duplicated.
    if (host === "yummyani.me" || host.endsWith(".yummyani.me")) {
      url.hostname = "yummyani.me";
    } else if (host === "yummy-ani.me" || host.endsWith(".yummy-ani.me")) {
      url.hostname = "yummy-ani.me";
    }
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

// Do not enqueue the same anime episode/source twice while an earlier
// event is still awaiting the user's confirmation. Once acknowledged, a
// later genuine rewatch can create a new queue entry.
function isDuplicatePendingEvent(queue, event) {
  const title = normalizeTitle(event.title);
  const sourceUrl = normalizeSourceUrl(event.sourceUrl);
  return queue.some((item) =>
    item.service === event.service &&
    normalizeTitle(item.title) === title &&
    Number(item.episode) === event.episode &&
    (Number(item.season) || null) === (Number(event.season) || null) &&
    normalizeSourceUrl(item.sourceUrl) === sourceUrl
  );
}

function drawToolbarIcon(alerted) {
  const size = 32;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size, size);

  context.save();
  if (alerted) {
    context.shadowColor = "#ff244f";
    context.shadowBlur = 10;
  }
  const background = context.createLinearGradient(2, 2, 30, 30);
  background.addColorStop(0, alerted ? "#4b172b" : "#302744");
  background.addColorStop(1, alerted ? "#241522" : "#171522");
  context.fillStyle = background;
  context.beginPath();
  context.roundRect(2, 2, 28, 28, 7);
  context.fill();
  context.restore();

  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = alerted ? "#ffb4c3" : "#e7c5ff";
  context.lineWidth = 3.2;
  context.beginPath();
  context.moveTo(8, 23);
  context.lineTo(10, 9);
  context.lineTo(16, 18);
  context.lineTo(22, 9);
  context.lineTo(24, 23);
  context.stroke();

  context.fillStyle = alerted ? "#ff4d70" : "#f2a9df";
  for (let petal = 0; petal < 5; petal += 1) {
    const angle = (Math.PI * 2 * petal) / 5;
    const x = 25 + Math.cos(angle) * 2.2;
    const y = 7 + Math.sin(angle) * 2.2;
    context.beginPath();
    context.arc(x, y, 1.45, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#fff0a8";
  context.beginPath();
  context.arc(25, 7, 0.9, 0, Math.PI * 2);
  context.fill();

  return context.getImageData(0, 0, size, size);
}

async function renderToolbarState(state) {
  const episode = Number.isSafeInteger(state.episode) && state.episode > 0
    ? String(state.episode)
    : "";
  await chrome.action.setIcon({ imageData: drawToolbarIcon(Boolean(state.alerted)) });
  await chrome.action.setBadgeText({ text: episode });
  await chrome.action.setBadgeBackgroundColor({
    color: state.alerted ? "#e3264f" : "#594b70",
  });
  await chrome.action.setTitle({
    title: episode
      ? `mido-anime-sync · серия ${episode}${state.alerted ? " · новое событие" : ""}`
      : "mido-anime-sync",
  });
}

async function getToolbarState() {
  const stored = await chrome.storage.local.get({
    [TOOLBAR_STATE_KEY]: { title: "", episode: null, alerted: false },
  });
  const state = stored[TOOLBAR_STATE_KEY];
  return state && typeof state === "object"
    ? { title: "", episode: null, alerted: false, ...state }
    : { title: "", episode: null, alerted: false };
}

async function saveToolbarState(state) {
  await chrome.storage.local.set({ [TOOLBAR_STATE_KEY]: state });
  await renderToolbarState(state);
}

function updateCurrentWatchContext(message) {
  return enqueueToolbarMutation(async () => {
  const title = typeof message.title === "string" ? message.title.trim() : "";
  if (title.length < 2) return;
  const episode = Number.isSafeInteger(message.episode) && message.episode > 0
    ? message.episode
    : null;
  const current = await getToolbarState();
  const sameTitle = normalizeTitle(current.title) === normalizeTitle(title);
  const sameEpisode = current.episode === episode;
  if (sameTitle && sameEpisode) return;

  // A different title or episode starts a fresh toolbar state. The previous
  // episode number and its unread glow must not leak into the next watch.
  await saveToolbarState({
    title,
    episode: null,
    alerted: false,
  });
  });
}

function clearToolbarState() {
  return enqueueToolbarMutation(async () => {
    await saveToolbarState({ title: "", episode: null, alerted: false });
  });
}

// Restore the icon from persisted state whenever the MV3 service worker starts.
void enqueueToolbarMutation(async () => {
  const state = await getToolbarState();
  await renderToolbarState(state);
});

function isSupportedWatchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return [
      "anime-go.org", "animego.online", "animego.me",
      "yummyani.me", "yummy-ani.me", "anixart.site",
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function refreshForActiveTab(tabId, knownTab) {
  let tab = knownTab;
  if (!tab?.url && chrome.tabs?.get) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
  }
  if (!isSupportedWatchUrl(tab?.url)) {
    await clearToolbarState();
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "MIDAHOSHI_REFRESH_WATCH_CONTEXT" });
  } catch {
    // The content script will publish its context after it finishes loading.
  }
}

chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  void refreshForActiveTab(tabId);
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    void refreshForActiveTab(tabId, tab);
  }
});

async function handleAnimeGoListExport(message, sender, sendResponse) {
  try {
    const senderUrl = new URL(sender.url || sender.tab?.url || "");
    const host = senderUrl.hostname.toLowerCase();
    const allowed = ["animego.me", "anime-go.org", "animego.online"]
      .some((domain) => host === domain || host.endsWith("." + domain));
    if (!allowed || !/^\/(?:profile|user)\//.test(senderUrl.pathname)) {
      throw new Error("Импорт доступен только на странице профиля AnimeGO.");
    }
    const payload = message.payload;
    if (!payload || ![1, 2, 3, 4, 5, 6].includes(Number(payload.listType)) ||
        !Array.isArray(payload.entries) || payload.entries.length === 0 || payload.entries.length > 5000) {
      throw new Error("Некорректный список AnimeGO или превышен лимит 5000 записей.");
    }
    const sourceUrl = new URL(String(payload.sourceUrl || ""));
    if (sourceUrl.origin !== senderUrl.origin || sourceUrl.pathname !== senderUrl.pathname ||
        Number(sourceUrl.searchParams.get("type") || 1) !== Number(payload.listType)) {
      throw new Error("Адрес списка не совпадает с открытой страницей профиля или выбранным статусом.");
    }
    const entries = payload.entries.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const animeId = String(row.animeId || "").trim();
      const title = String(row.title || "").trim().slice(0, 300);
      if (!/^\d+$/.test(animeId) || !title) return [];
      const score = row.score == null ? null : Number(row.score);
      let posterUrl = null;
      try {
        const candidate = new URL(String(row.posterUrl || ""));
        if (candidate.protocol === "https:" || candidate.protocol === "http:") posterUrl = candidate.toString();
      } catch {}
      return [{
        animeId,
        title,
        originalTitle: typeof row.originalTitle === "string" ? row.originalTitle.trim().slice(0, 300) : null,
        score: Number.isFinite(score) && score >= 1 && score <= 10 ? score : null,
        posterUrl,
      }];
    });
    if (!entries.length) throw new Error("В списке не найдено записей с корректными AnimeGO ID.");
    const importId = crypto.randomUUID();
    const storageKey = "animeGoAccountImport:" + importId;
    await chrome.storage.local.set({
      [storageKey]: {
        listType: Number(payload.listType),
        sourceUrl: sourceUrl.toString(),
        entries,
        createdAt: new Date().toISOString(),
      },
    });
    const settings = await chrome.storage.local.get({ appUrl: "http://127.0.0.1:5173" });
    const destination = new URL(settings.appUrl);
    if (destination.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(destination.hostname) ||
        !["5173", "3001", "4173"].includes(destination.port || "80")) {
      await chrome.storage.local.remove(storageKey);
      throw new Error("Некорректный адрес локального приложения. Проверь настройки расширения.");
    }
    destination.searchParams.set("animegoImportId", importId);
    await chrome.tabs.create({ url: destination.toString() });
    sendResponse({ ok: true, count: entries.length });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "Не удалось передать список AnimeGO." });
  }
}

function isLocalAppSender(sender) {
  try {
    const url = new URL(sender.url || sender.tab?.url || "");
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      ["5173", "3001", "4173"].includes(url.port || "80");
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MIDAHOSHI_ANIMEGO_LIST_EXPORT") {
    void handleAnimeGoListExport(message, sender, sendResponse);
    return true;
  }

  if (message?.type === "MIDAHOSHI_GET_ANIMEGO_IMPORT") {
    void (async () => {
      try {
        if (!isLocalAppSender(sender)) throw new Error("Запрос импорта разрешён только локальному приложению.");
        const importId = String(message.importId || "");
        if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Error("Некорректный ID импорта.");
        const storageKey = "animeGoAccountImport:" + importId;
        const stored = await chrome.storage.local.get({ [storageKey]: null });
        sendResponse(stored[storageKey]
          ? { ok: true, payload: stored[storageKey] }
          : { ok: false, error: "Переданный список AnimeGO не найден или уже импортирован." });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Не удалось получить список AnimeGO." });
      }
    })();
    return true;
  }

  if (message?.type === "MIDAHOSHI_ACK_ANIMEGO_IMPORT") {
    void (async () => {
      try {
        if (!isLocalAppSender(sender)) throw new Error("Подтверждение разрешено только локальному приложению.");
        const importId = String(message.importId || "");
        if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Error("Некорректный ID импорта.");
        await chrome.storage.local.remove("animeGoAccountImport:" + importId);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Не удалось подтвердить импорт." });
      }
    })();
    return true;
  }

  if (message?.type === "MIDAHOSHI_DISMISS_ALERT") {
    void enqueueToolbarMutation(async () => {
      const state = await getToolbarState();
      if (!state.alerted) return;
      await saveToolbarState({ ...state, alerted: false });
    });
    return;
  }

  if (message?.type === "MIDAHOSHI_CURRENT_WATCH") {
    void updateCurrentWatchContext(message);
    return;
  }

  if (message?.type === "MIDAHOSHI_APP_ACK" && typeof message.eventId === "string") {
    void (async () => {
      await enqueueToolbarMutation(async () => {
        const stored = await chrome.storage.local.get({ [QUEUE_KEY]: [] });
        const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
        const nextQueue = queue.filter((item) => item.eventId !== message.eventId);
        if (nextQueue.length !== queue.length) {
          await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
        }
      });
    })();
    return;
  }

  if (message?.type !== "MIDAHOSHI_AUTO_WATCH_EVENT" || !message.event) return;

  void enqueueToolbarMutation(async () => {
    const event = message.event;
    const duration = Number(event.durationSeconds);
    const currentTime = Number(event.currentTimeSeconds);
    if (
      !["animego", "yummyanime", "anixart"].includes(event.service) ||
      typeof event.title !== "string" ||
      event.title.trim().length < 2 ||
      !Number.isSafeInteger(event.episode) ||
      event.episode < 1 ||
      !allowedSourceUrl(event.service, event.sourceUrl) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(currentTime) ||
      currentTime / duration < 0.9
    ) return;

    const stored = await chrome.storage.local.get({ [QUEUE_KEY]: [] });
    const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
    if (isDuplicatePendingEvent(queue, event)) return;
    const eventId = String(event.eventId || crypto.randomUUID());
    if (queue.some((item) => item.eventId === eventId)) return;

    queue.push({
      eventId,
      service: event.service,
      title: event.title.trim(),
      episode: event.episode,
      sourceUrl: event.sourceUrl,
      observedAt: new Date().toISOString(),
      currentTimeSeconds: currentTime,
      durationSeconds: duration,
      ...(typeof event.season === "number" && Number.isSafeInteger(event.season) && event.season > 0 ? { season: event.season } : {}),
      ...(typeof event.voice === "string" && event.voice.trim() ? { voice: event.voice.trim().slice(0, 100) } : {}),
    });
    // Pending events are user-confirmed work waiting for delivery. Never
    // silently discard older events just because the queue grows past a UI
    // convenience limit; Chrome storage quota errors are handled by the
    // serialized operation wrapper and leave the previous queue intact.
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });

    await saveToolbarState({
      title: event.title.trim(),
      episode: event.episode,
      alerted: true,
    });
  });
});
