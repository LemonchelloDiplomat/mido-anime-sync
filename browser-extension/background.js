const QUEUE_KEY = "pendingWatchEvents";
const TOOLBAR_STATE_KEY = "toolbarWatchState";

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
  return false;
}

function normalizeTitle(title) {
  return String(title || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
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

async function updateCurrentWatchContext(message) {
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
}

async function clearToolbarState() {
  await saveToolbarState({ title: "", episode: null, alerted: false });
}

// Restore the icon from persisted state whenever the MV3 service worker starts.
void (async () => {
  const state = await getToolbarState();
  await renderToolbarState(state);
})();

function isSupportedWatchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return [
      "anime-go.org", "animego.online", "animego.me",
      "yummyani.me", "yummy-ani.me",
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MIDAHOSHI_DISMISS_ALERT") {
    void (async () => {
      const state = await getToolbarState();
      if (!state.alerted) return;
      await saveToolbarState({ ...state, alerted: false });
    })();
    return;
  }

  if (message?.type === "MIDAHOSHI_CURRENT_WATCH") {
    void updateCurrentWatchContext(message);
    return;
  }

  if (message?.type === "MIDAHOSHI_APP_ACK" && typeof message.eventId === "string") {
    void (async () => {
      const stored = await chrome.storage.local.get({ [QUEUE_KEY]: [] });
      const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
      const nextQueue = queue.filter((item) => item.eventId !== message.eventId);
      await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
    })();
    return;
  }

  if (message?.type !== "MIDAHOSHI_AUTO_WATCH_EVENT" || !message.event) return;

  void (async () => {
    const event = message.event;
    const duration = Number(event.durationSeconds);
    const currentTime = Number(event.currentTimeSeconds);
    if (
      !["animego", "yummyanime"].includes(event.service) ||
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
    const eventId = String(event.eventId || crypto.randomUUID());
    if (!queue.some((item) => item.eventId === eventId)) {
      queue.push({
        eventId,
        service: event.service,
        title: event.title.trim(),
        episode: event.episode,
        sourceUrl: event.sourceUrl,
        observedAt: new Date().toISOString(),
        currentTimeSeconds: currentTime,
        durationSeconds: duration,
      });
      await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-20) });
    }

    const current = await getToolbarState();
    await saveToolbarState({
      title: event.title.trim(),
      episode: event.episode,
      alerted: true,
    });
  })();
});
