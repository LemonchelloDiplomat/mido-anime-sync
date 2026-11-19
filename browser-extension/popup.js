const titleInput = document.getElementById("title");
const episodeInput = document.getElementById("episode");
const statusElement = document.getElementById("status");
let detected = null;

function status(message) {
  statusElement.textContent = message;
}

document.getElementById("scan").addEventListener("click", async () => {
  status("Считываем страницу…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    status("Не удалось определить активную вкладку.");
    return;
  }
  try {
    detected = await chrome.tabs.sendMessage(tab.id, { type: "MIDAHOSHI_DETECT_WATCH_EVENT" });
    titleInput.value = detected.title || detected.pageTitle || "";
    episodeInput.value = detected.episode || "";
    const note = detected.manualOnly
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
    const service = host.includes("yummyani.me") || host.includes("yummy-ani.me") || host.includes("yummyanime.club") || host.includes("yummyanime.info")
      ? "yummyanime"
      : host.includes("anixart-app.com")
        ? "anixart"
        : host.includes("anime-go.org") || host.includes("animego.online")
          ? "animego"
          : null;
    if (!service) {
      status("Эта страница не относится к поддерживаемым источникам.");
      return;
    }
    detected = { service, sourceUrl: tab.url, currentTimeSeconds: null, durationSeconds: null };
  }

  const event = {
    service: detected.service,
    title,
    episode,
    sourceUrl: detected.sourceUrl,
    observedAt: new Date().toISOString(),
    currentTimeSeconds: detected.currentTimeSeconds ?? null,
    durationSeconds: detected.durationSeconds ?? null,
  };
  const { appUrl = "http://127.0.0.1:5173" } = await chrome.storage.local.get({ appUrl: "http://127.0.0.1:5173" });
  let destination;
  try {
    destination = new URL(appUrl);
    if (!["http:", "https:"].includes(destination.protocol)) throw new Error("invalid protocol");
    destination.searchParams.set("watchEvent", JSON.stringify(event));
  } catch {
    status("Некорректный адрес локального приложения. Проверь настройки расширения.");
    return;
  }
  await chrome.tabs.create({ url: destination.toString() });
  status("Событие открыто в MidaHoshi Anime Sync. Выбери соответствующий тайтл и подтверди запись прогресса.");
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());