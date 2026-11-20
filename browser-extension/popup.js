const titleInput = document.getElementById("title");
const episodeInput = document.getElementById("episode");
const statusElement = document.getElementById("status");
let detected = null;
let pendingEventId = null;

function status(message) {
  statusElement.textContent = message;
}

function showQueuedEvent(latest) {
  if (!latest) return;
  detected = latest;
  pendingEventId = latest.eventId || null;
  titleInput.value = latest.title || "";
  episodeInput.value = latest.episode || "";
  status("Обнаружена серия, просмотренная более чем на 90%. Проверь данные и нажми «Передать в локальную библиотеку».");
}

async function loadQueuedEvent() {
  const { pendingWatchEvents = [] } = await chrome.storage.local.get({ pendingWatchEvents: [] });
  const latest = Array.isArray(pendingWatchEvents) ? pendingWatchEvents[pendingWatchEvents.length - 1] : null;
  if (latest) showQueuedEvent(latest);
  else status("Ничего не найдено. После просмотра 90% серии поддерживаемый сайт автоматически добавит её сюда.");
}

void loadQueuedEvent();

// Keep an already-open popup in sync with events detected by the background
// worker. This also replaces an old scan error with the current success state.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.pendingWatchEvents) return;
  const queue = changes.pendingWatchEvents.newValue;
  const latest = Array.isArray(queue) ? queue[queue.length - 1] : null;
  if (latest) showQueuedEvent(latest);
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
    // A missing or stalled content-script listener must not leave the popup
    // stuck forever on "Считываем страницу…".
    detected = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: "MIDAHOSHI_DETECT_WATCH_EVENT" }),
      new Promise((_, reject) => window.setTimeout(
        () => reject(new Error("watch scan timed out")),
        5000,
      )),
    ]);
    pendingEventId = null;
    titleInput.value = detected.title || detected.pageTitle || "";
    episodeInput.value = detected.episode || "";
    const hasSourceMetadata = ["animego", "yummyanime"].includes(detected.service) &&
      typeof detected.title === "string" && detected.title.trim().length > 2 &&
      Number.isSafeInteger(detected.episode) && detected.episode > 0;
    const sourceName = detected.service === "yummyanime" ? "YummyAnime" : "AnimeGO";
    const note = hasSourceMetadata && detected.manualOnly
      ? `Название и серия найдены на ${sourceName}. Видео находится во встроенном плеере. Продолжай просмотр: событие появится автоматически после 90%.`
      : detected.manualOnly
        ? "Плеер или номер серии не обнаружен. Проверь название и введи номер вручную."
        : detected.episode
          ? "Найден видеоплеер и предполагаемый номер серии. Проверь данные перед отправкой."
          : "Плеер найден, но номер серии нужно ввести вручную.";
    status(note);
  } catch (error) {
    status(error?.message === "watch scan timed out"
      ? "Скрипт страницы не ответил за 5 секунд. Перезагрузи вкладку и проверь, что расширение включено для этого сайта."
      : "Эта страница не поддерживается. Открой AnimeGO, YummyAnime или веб-страницу Anixart.");
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