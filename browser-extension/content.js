(() => {
  const host = location.hostname.toLowerCase();
  const service = host.includes("yummy") ? "yummyanime"
    : host.includes("anixart") ? "anixart"
    : "animego";

  const titleSelectors = service === "animego"
    ? ["h1", ".anime-title", ".watch-title", ".video-title", "[itemprop='name']"]
    : service === "yummyanime"
      ? ["h1", ".watch__title", ".video-title", ".player__title", "[itemprop='name']"]
      : ["h1", "[itemprop='name']", "meta[property='og:title']"];

  const episodeSelectors = service === "animego"
    ? [".video-title", ".episode-title", "[data-episode]", "select[name*='episode' i]"]
    : service === "yummyanime"
      ? [".watch__episode", ".episode-title", "[data-episode]", "select[name*='episode' i]"]
      : ["[data-episode]", ".episode-title"];

  const sentVideoKeys = new WeakMap();

  function textFrom(selector) {
    const element = document.querySelector(selector);
    if (!element) return "";
    if (element instanceof HTMLSelectElement) {
      return (element.selectedOptions[0]?.textContent || element.value || "").trim();
    }
    return (element.getAttribute("content") || element.getAttribute("value") || element.textContent || "").trim();
  }

  function findEpisode(text) {
    const value = String(text || "");
    const patterns = [
      /(?:серия|эпизод|episode|ep\.?)[\s:#№-]*(\d{1,4})/i,
      /(\d{1,4})\s*(?:серия|эпизод|episode|ep\.?)/i,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function findAnimeGoActiveEpisode() {
    const activeItem = document.querySelector(".player-video-bar__item.active");
    const rawNumber = activeItem?.getAttribute("data-episode-number") || "";
    if (/^\d{1,4}$/.test(rawNumber)) {
      const episode = Number(rawNumber);
      if (Number.isSafeInteger(episode) && episode > 0) return episode;
    }

    const activeButton = activeItem?.querySelector("button.player-video-bar__number");
    return findEpisode(activeButton?.getAttribute("aria-label") || activeButton?.textContent || "");
  }

  function findMainVideo() {
    const candidates = Array.from(document.querySelectorAll("video")).filter((video) => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      return rect.width >= 200 && rect.height >= 100 &&
        style.display !== "none" && style.visibility !== "hidden";
    });
    candidates.sort((first, second) => {
      const a = first.getBoundingClientRect();
      const b = second.getBoundingClientRect();
      return b.width * b.height - a.width * a.height;
    });
    return candidates[0] || null;
  }

  function detect(videoOverride) {
    const titleMeta = document.querySelector("meta[property='og:title']");
    const titleCandidates = [
      ...titleSelectors.map(textFrom),
      titleMeta?.getAttribute("content") || "",
      document.title,
    ].filter(Boolean);
    let title = titleCandidates.find((candidate) => candidate.length > 2) || "";
    title = title
      .replace(/\s*[|·-]\s*(AnimeGO|YummyAnime|Anixart).*$/i, "")
      .replace(/\s*[|·-]\s*(смотреть аниме онлайн).*$/i, "")
      .replace(/\s*(?:серия|эпизод|episode|ep\.?)[\s:#№-]*\d{1,4}.*$/i, "")
      .trim();

    const activeAnimeGoEpisode = service === "animego" ? findAnimeGoActiveEpisode() : null;
    const episodeCandidates = [
      ...episodeSelectors.map(textFrom),
      document.title,
      ...Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8).map((el) => el.textContent || ""),
      location.pathname,
    ];
    let episode = activeAnimeGoEpisode;
    if (!episode) {
      for (const candidate of episodeCandidates) {
        episode = findEpisode(candidate);
        if (episode) break;
      }
    }

    const video = videoOverride || findMainVideo();
    const currentTimeSeconds = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null;
    const durationSeconds = video && Number.isFinite(video.duration) && video.duration > 0
      ? Math.floor(video.duration)
      : null;

    return {
      service,
      title,
      episode,
      sourceUrl: location.origin + location.pathname,
      currentTimeSeconds,
      durationSeconds,
      hasVideoElement: Boolean(video),
      manualOnly: service === "anixart" || !video || durationSeconds == null,
      pageTitle: document.title,
    };
  }

  function attachVideo(video) {
    if (video.dataset.midahoshiWatchAttached === "true") return;
    video.dataset.midahoshiWatchAttached = "true";

    const maybeSend = () => {
      const duration = Number(video.duration);
      const currentTime = Number(video.currentTime);
      if (!Number.isFinite(duration) || duration <= 0 || currentTime / duration < 0.9) return;

      const detected = detect(video);
      if (detected.manualOnly || !detected.title || !Number.isSafeInteger(detected.episode) || detected.episode < 1) return;

      // Some SPA players reuse one <video> element for every episode.
      // Deduplicate by the actual episode/source, not by the element lifetime.
      const videoKey = [
        location.origin + location.pathname,
        video.currentSrc || video.src || "",
        detected.episode,
      ].join("|");
      if (sentVideoKeys.get(video) === videoKey) return;
      sentVideoKeys.set(video, videoKey);
      chrome.runtime.sendMessage({
        type: "MIDAHOSHI_AUTO_WATCH_EVENT",
        event: {
          ...detected,
          eventId: crypto.randomUUID(),
          observedAt: new Date().toISOString(),
        },
      });
    };

    video.addEventListener("timeupdate", maybeSend, { passive: true });
    video.addEventListener("ended", maybeSend, { passive: true });
  }

  function scanVideos() {
    const mainVideo = findMainVideo();
    if (mainVideo) attachVideo(mainVideo);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MIDAHOSHI_DETECT_WATCH_EVENT") {
      sendResponse(detect());
    }
    return true;
  });

  scanVideos();
  const observer = new MutationObserver(scanVideos);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
})();