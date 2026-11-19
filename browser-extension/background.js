const QUEUE_KEY = "pendingWatchEvents";

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
      host === "animego.online" || host.endsWith(".animego.online");
  }
  if (service === "yummyanime") {
    return host === "yummyani.me" || host.endsWith(".yummyani.me") ||
      host === "yummy-ani.me" || host.endsWith(".yummy-ani.me");
  }
  return false;
}

async function updateBadge(queue) {
  const text = queue.length > 0 ? String(Math.min(queue.length, 99)) : "";
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: "#7357d9" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MIDAHOSHI_APP_ACK" && typeof message.eventId === "string") {
    void (async () => {
      const stored = await chrome.storage.local.get({ [QUEUE_KEY]: [] });
      const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
      const nextQueue = queue.filter((item) => item.eventId !== message.eventId);
      await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
      await updateBadge(nextQueue);
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
    if (!queue.some((item) => item.eventId === event.eventId)) {
      queue.push({
        eventId: String(event.eventId || crypto.randomUUID()),
        service: event.service,
        title: event.title.trim(),
        episode: event.episode,
        sourceUrl: event.sourceUrl,
        observedAt: new Date().toISOString(),
        currentTimeSeconds: currentTime,
        durationSeconds: duration,
      });
      const nextQueue = queue.slice(-20);
      await chrome.storage.local.set({ [QUEUE_KEY]: nextQueue });
      await updateBadge(nextQueue);
    }
  })();
});