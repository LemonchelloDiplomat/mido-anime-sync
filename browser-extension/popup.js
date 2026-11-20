const titleInput = document.getElementById("title");
const episodeInput = document.getElementById("episode");
const statusElement = document.getElementById("status");
let detected = null;
let pendingEventId = null;

function status(message) {
  statusElement.textContent = message;
}

const pendingList = document.getElementById("pending-list");
const pendingCount = document.getElementById("pending-count");

async function renderPendingEvents() {
  const { pendingWatchEvents = [] } = await chrome.storage.local.get({ pendingWatchEvents: [] });
  const queue = Array.isArray(pendingWatchEvents) ? pendingWatchEvents : [];
  pendingCount.textContent = `(${queue.length})`;
  pendingList.replaceChildren();

  if (queue.length === 0) {
    const empty = document.createElement("div");
    empty.id = "pending-empty";
    empty.textContent = "Нет сохранённых событий.";
    pendingList.append(empty);
    return;
  }

  for (const event of [...queue].reverse()) {
    const item = document.createElement("div");
    item.className = "pending-item";

    const title = document.createElement("div");
    title.className = "pending-title";
    title.textContent = event.title || "Без названия";

    const meta = document.createElement("div");
    meta.className = "pending-meta";
    meta.textContent = `Серия ${event.episode || "?"} · ${event.service || "источник"}`;

    const selectButton = document.createElement("button");
    selectButton.className = "secondary";
    selectButton.type = "button";
    selectButton.textContent = "Проверить данные";
    selectButton.addEventListener("click", () => {
      detected = event;
      pendingEventId = event.eventId || null;
      titleInput.value = event.title || "";
      episodeInput.value = event.episode || "";
      status("Событие выбрано. Проверь название и серию, затем нажми «Передать в локальную библиотеку».");
    });

    item.append(title, meta, selectButton);
    pendingList.append(item);
  }
}

void renderPendingEvents();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.pendingWatchEvents) {
    void renderPendingEvents();
  }
});

// Opening the toolbar popup acknowledges the red notification without
// removing the pending watch event from the delivery queue.
void chrome.runtime.sendMessage({ type: "MIDAHOSHI_DISMISS_ALERT" }).catch(() => {});

document.getElementById("scan").addEventListener("click", async () => {
  status("Считываем страницу…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    status("Не удалось определить активную вкладку.");
    return;
  }
  try {
    detected = await chrome.tabs.sendMessage(tab.id, { type: "MIDAHOSHI_DETECT_WATCH_EVENT" });
    pendingEventId = null;
    titleInput.value = detected.title || detected.pageTitle || "";
    episodeInput.value = detected.episode || "";
    const hasAnimeGoMetadata = detected.service === "animego" &&
      typeof detected.title === "string" && detected.title.trim().length > 2 &&
      Number.isSafeInteger(detected.episode) && detected.episode > 0;
    const note = hasAnimeGoMetadata && detected.manualOnly
      ? "Название и серия найдены на AnimeGO. Видео находится во встроенном плеере. Продолжай просмотр: событие появится автоматически после 90%."
      : detected.manualOnly
        ? "Плеер или номер серии не обнаружен. Проверь название и введи номер вручную."
        : detected.episode
          ? "Найден видеоплеер и предполагаемый номер серии. Проверь данные перед отправкой."
          : "Плеер найден, но номер серии нужно ввести вручную.";
    status(note);
  } catch {
    status("Эта страница не поддерживается. Открой AnimeGO, YummyAnime или веб-страницу Anixart.");
  }
});

document.getElementById("send").addEventListener("click", async () => {
  const title = titleInput.value.trim();
  const episode = Number(episodeInput.value);
  if (!title || !Number.isSafeInteger(episode) || episode < 1) {
    status("Укажи название и корректный номер серии.");
    return;
  }
  if (!detected) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      status("Не удалось определить страницу-источник.");
      return;
    }
    const host = new URL(tab.url).hostname.toLowerCase();
    const service = host.includes("yummyani.me") || host.includes("yummy-ani.me")
      ? "yummyanime"
      : (host.includes("anixart-app.com") || host.includes("anixartapp.com"))
        ? "anixart"
        : host === "animego.me" || host.endsWith(".animego.me") || host.includes("anime-go.org") || host.includes("animego.online")
          ? "animego"
          : null;
    if (!service) {
      status("Эта страница не относится к поддерживаемым источникам.");
      return;
    }
    const sourceUrl = new URL(tab.url);
    sourceUrl.search = "";
    sourceUrl.hash = "";
    detected = { service, sourceUrl: sourceUrl.toString(), currentTimeSeconds: null, durationSeconds: null };
  }

  const event = {
    ...(pendingEventId ? { eventId: pendingEventId } : {}),
    service: detected.service,
    title,
    episode,
    sourceUrl: detected.sourceUrl,
    observedAt: detected.observedAt || new Date().toISOString(),
    currentTimeSeconds: detected.currentTimeSeconds ?? null,
    durationSeconds: detected.durationSeconds ?? null,
  };
  const { appUrl = "http://127.0.0.1:5173" } = await chrome.storage.local.get({ appUrl: "http://127.0.0.1:5173" });
  let destination;
  try {
    destination = new URL(appUrl);
    const allowedHosts = new Set(["127.0.0.1", "localhost"]);
    const allowedPorts = new Set(["5173", "3001", "4173"]);
    if (
      destination.protocol !== "http:" ||
      !allowedHosts.has(destination.hostname) ||
      !allowedPorts.has(destination.port || "80")
    ) throw new Error("unsupported local app address");
    destination.searchParams.set("watchEvent", JSON.stringify(event));
  } catch {
    status("Некорректный адрес локального приложения. Проверь настройки расширения.");
    return;
  }
  try {
    await chrome.tabs.create({ url: destination.toString() });
    status("Событие открыто в mido-anime-sync. Очередь очистится после подтверждения или отмены события в приложении.");
  } catch {
    status("Не удалось открыть локальное приложение. Проверь, что оно запущено и адрес указан верно.");
  }
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());