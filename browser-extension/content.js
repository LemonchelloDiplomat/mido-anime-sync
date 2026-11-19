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
    ? [".video-title", ".episode-title", "[data-episode]", "select[name*='episode' i']"]
    : service === "yummyanime"
      ? [".watch__episode", ".episode-title", "[data-episode]", "select[name*='episode' i']"]
      : ["[data-episode]", ".episode-title"];

  function textFrom(selector) {
    const element = document.querySelector(selector);
    if (!element) return "";
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

  function detect() {
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
      .trim();

    const episodeCandidates = [
      ...episodeSelectors.map(textFrom),
      document.title,
      ...Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8).map((el) => el.textContent || ""),
      location.pathname,
    ];
    let episode = null;
    for (const candidate of episodeCandidates) {
      episode = findEpisode(candidate);
      if (episode) break;
    }

    const video = document.querySelector("video");
    const currentTimeSeconds = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null;
    const durationSeconds = video && Number.isFinite(video.duration) && video.duration > 0
      ? Math.floor(video.duration)
      : null;

    return {
      service,
      title,
      episode,
      sourceUrl: location.href,
      currentTimeSeconds,
      durationSeconds,
      hasVideoElement: Boolean(video),
      manualOnly: service === "anixart" || !video,
      pageTitle: document.title,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MIDAHOSHI_DETECT_WATCH_EVENT") {
      sendResponse(detect());
    }
    return true;
  });
})();