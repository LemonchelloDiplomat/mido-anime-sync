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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "MIDAHOSHI_ANIXART_CATALOG") {
    void (async () => {
      try {
        const senderUrl = new URL(sender?.url || "");
        if (senderUrl.protocol !== "https:" ||
            !(senderUrl.hostname === "anixart.site" || senderUrl.hostname.endsWith(".anixart.site"))) return;
        const catalog = message.catalog;
        if (!catalog || typeof catalog.slug !== "string" ||
            !/^\d+-[\p{L}\p{N}-]+\.html$/u.test(catalog.slug) ||
            !Array.isArray(catalog.seasons)) return;
        await fetch("http://127.0.0.1:3001/api/anixart/player-catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(catalog),
          credentials: "omit",
          cache: "no-store",
        });
      } catch {
        // The local app may be closed. The next player sample will retry.
      }
    })();
    return;
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
