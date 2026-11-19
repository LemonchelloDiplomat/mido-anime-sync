(() => {
  const adapters = window.__MIDA_WATCH_ADAPTERS || [];
  const adapter = adapters.find((item) => item.matches());
  if (!adapter) return;

  const sentVideos = new WeakSet();
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  function readElementValue(element) {
    if (!element) return "";
    if (element.tagName === "META") return element.content || "";
    return element.getAttribute("data-episode-number") ||
      element.getAttribute("data-episode") ||
      element.textContent ||
      "";
  }

  function extractTitle() {
    for (const selector of adapter.titleSelectors) {
      const element = document.querySelector(selector);
      const value = readElementValue(element);
      if (value) {
        const title = cleanText(value)
          .replace(adapter.titleSuffix, "")
          .replace(/\s*(?:серия|эпизод|episode|ep)\s*\d+.*$/i, "")
          .trim();
        if (title.length >= 2) return title;
      }
    }
    return "";
  }

  function extractEpisode() {
    for (const selector of adapter.episodeSelectors) {
      const element = document.querySelector(selector);
      const value = readElementValue(element);
      const match = /\b(\d{1,4})\b/.exec(cleanText(value));
      if (match) {
        const number = Number(match[1]);
        if (Number.isSafeInteger(number) && number > 0) return number;
      }
    }

    const sources = [location.pathname, location.search, document.title, document.querySelector("h1")?.textContent];
    for (const source of sources) {
      const match = /(?:episode|ep|series|seria|серия|эпизод)[\s/_=-]*(\d{1,4})/i.exec(String(source || ""));
      if (match) {
        const number = Number(match[1]);
        if (Number.isSafeInteger(number) && number > 0) return number;
      }
    }
    return null;
  }

  function emitCompleted(video) {
    if (sentVideos.has(video)) return;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 || currentTime / duration < 0.9) return;

    const title = extractTitle();
    const episode = extractEpisode();
    if (!title || !episode) return;

    sentVideos.add(video);
    chrome.runtime.sendMessage({
      type: "MIDA_WATCH_EVENT",
      event: {
        eventId: crypto.randomUUID(),
        service: adapter.service,
        title,
        episode,
        sourceUrl: location.href,
        observedAt: new Date().toISOString(),
      },
    });
  }

  function attachVideo(video) {
    if (video.dataset.midaWatchBridgeAttached === "true") return;
    video.dataset.midaWatchBridgeAttached = "true";
    video.addEventListener("timeupdate", () => emitCompleted(video), { passive: true });
    video.addEventListener("ended", () => emitCompleted(video), { passive: true });
  }

  function scanVideos() {
    document.querySelectorAll("video").forEach(attachVideo);
  }

  scanVideos();
  const observer = new MutationObserver(scanVideos);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
})();