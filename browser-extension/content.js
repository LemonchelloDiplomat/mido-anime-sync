(() => {
  const host = location.hostname.toLowerCase();
  const isAniBoomFrame = host === "aniboom.one";
  const isCvhFrame = host === "animego.me" && location.pathname.startsWith("/cdn-iframe/");
  const isCvhPlayerFrame = host === "player.cdnvideohub.com";
  const isCvhTrackingFrame = isCvhFrame || isCvhPlayerFrame;
  const isKodikFrame = host === "kodikplayer.com";
  const isAnimeGoPlayerFrame = isAniBoomFrame || isCvhTrackingFrame || isKodikFrame;
  const service = isAnimeGoPlayerFrame ? "animego" : host.includes("yummy") ? "yummyanime"
    : host.includes("anixart") ? "anixart"
    : "animego";
  let parentMetadata = null;
  let latestCvhSample = null;
  let previousCvhTime = null;
  let cvhMetadataKey = null;
  let cvhAwaitingEpisodeStart = false;
  let kodikMetadataKey = null;
  let kodikAwaitingEpisodeStart = false;
  let previousKodikTime = null;
  let aniboomMetadataKey = null;
  let aniboomAwaitingEpisodeStart = false;
  let previousAniBoomTime = null;
  const sentAniBoomKeys = new Set();
  const sentCvhKeys = new Set();
  const sentKodikKeys = new Set();

  function isAllowedAnimeGoUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      return (url.protocol === "https:" || url.protocol === "http:") &&
        (hostname === "anime-go.org" || hostname.endsWith(".anime-go.org") ||
          hostname === "animego.online" || hostname.endsWith(".animego.online") ||
          hostname === "animego.me" || hostname.endsWith(".animego.me"));
    } catch {
      return false;
    }
  }

  function isAllowedWatchSourceUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      return isAllowedAnimeGoUrl(rawUrl) ||
        ((url.protocol === "https:" || url.protocol === "http:") &&
          (hostname === "yummyani.me" || hostname.endsWith(".yummyani.me") ||
            hostname === "yummy-ani.me" || hostname.endsWith(".yummy-ani.me")));
    } catch {
      return false;
    }
  }

  const titleSelectors = service === "animego"
    ? ["h1", ".anime-title", ".watch-title", ".video-title", "[itemprop='name']"]
    : service === "yummyanime"
      ? ["h1", ".watch__title", ".video-title", ".player__title", ".anime-title", ".watch-title", "[data-anime-title]", "[itemprop='name']"]
      : ["h1", "[itemprop='name']", "meta[property='og:title']"];

  const episodeSelectors = service === "animego"
    ? [".video-title", ".episode-title", "[data-episode]", "select[name*='episode' i]"]
    : service === "yummyanime"
      ? [".watch__episode", ".episode-title", "[data-episode]", "select[name*='episode' i]"]
      : ["[data-episode]", ".episode-title"];

  const sentVideoKeys = new WeakMap();
  const videoWatchHandlers = new WeakMap();

  let lastPublishedContextKey = "";

  function publishCurrentWatchContext() {
    if (isAnimeGoPlayerFrame) return;
    if (service !== "animego" && service !== "yummyanime") return;

    const current = detect();
    const title = typeof current.title === "string" ? current.title.trim() : "";
    if (title.length < 2) return;
    const episode = Number.isSafeInteger(current.episode) && current.episode > 0
      ? current.episode
      : null;
    const contextKey = [normalizeWatchTitle(title), episode ?? ""].join("|");
    if (contextKey === lastPublishedContextKey) return;
    lastPublishedContextKey = contextKey;

    if (typeof chrome.runtime.sendMessage === "function") {
      chrome.runtime.sendMessage({
        type: "MIDAHOSHI_CURRENT_WATCH",
        title,
        episode,
      });
    }
  }

  function normalizeWatchTitle(value) {
    return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  }

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
      /(?:сер(?:ия|ии|ию)|эпизод|episode|ep\.?)[\s:#№-]*(\d{1,4})/i,
      /(\d{1,4})\s*(?:сер(?:ия|ии|ию)|эпизод|episode|ep\.?)/i,
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
    if (isCvhTrackingFrame && parentMetadata) {
      return {
        service: "animego",
        title: parentMetadata.title,
        episode: parentMetadata.episode,
        sourceUrl: parentMetadata.sourceUrl,
        currentTimeSeconds: latestCvhSample ? Math.ceil(latestCvhSample.currentTime) : null,
        durationSeconds: latestCvhSample ? Math.floor(latestCvhSample.duration) : null,
        hasVideoElement: Boolean(latestCvhSample),
        manualOnly: !latestCvhSample,
        pageTitle: document.title,
      };
    }

    if (isKodikFrame && parentMetadata) {
      const video = videoOverride || findMainVideo();
      const currentTimeSeconds = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null;
      const durationSeconds = video && Number.isFinite(video.duration) && video.duration > 0
        ? Math.floor(video.duration)
        : null;
      return {
        service: parentMetadata.service || "animego",
        title: parentMetadata.title,
        episode: parentMetadata.episode,
        sourceUrl: parentMetadata.sourceUrl,
        currentTimeSeconds,
        durationSeconds,
        hasVideoElement: Boolean(video),
        manualOnly: !video || durationSeconds == null,
        pageTitle: document.title,
      };
    }

    if (isAniBoomFrame && parentMetadata) {
      const video = videoOverride || findMainVideo();
      const currentTimeSeconds = video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : null;
      const durationSeconds = video && Number.isFinite(video.duration) && video.duration > 0
        ? Math.floor(video.duration)
        : null;
      return {
        service: "animego",
        title: parentMetadata.title,
        episode: parentMetadata.episode,
        sourceUrl: parentMetadata.sourceUrl,
        currentTimeSeconds,
        durationSeconds,
        hasVideoElement: Boolean(video),
        manualOnly: !video || durationSeconds == null,
        pageTitle: document.title,
      };
    }

    const titleMeta = document.querySelector("meta[property='og:title']");
    const titleMetaFallback = document.querySelector("meta[name='title']");
    const titleCandidates = [
      ...titleSelectors.map(textFrom),
      titleMeta?.getAttribute("content") || "",
      titleMetaFallback?.getAttribute("content") || "",
      document.querySelector('img[src*="posters"][alt]')?.getAttribute("alt") || "",
      document.title,
    ];
    const isUsableAnimeTitle = (candidate) => {
      const normalized = String(candidate || "").trim().toLocaleLowerCase();
      if (normalized.length < 2 || /^[.…\-–—_]+$/.test(normalized)) return false;
      return !/^(?:загрузка|loading|yummyanime|animego|смотреть аниме(?: онлайн)?)(?:\s*[|·\-–—].*)?$/i.test(normalized);
    };
    let title = titleCandidates.find(isUsableAnimeTitle) || "";
    title = title
      .replace(/\s*[|·-]\s*(AnimeGO|YummyAnime|Anixart).*$/i, "")
      .replace(/\s*[|·-]\s*(смотреть аниме онлайн).*$/i, "")
      .replace(/\s*(?:сер(?:ия|ии|ию)|эпизод|episode|ep\.?)[\s:#№-]*\d{1,4}.*$/i, "")
      .trim();

    const activeAnimeGoEpisode = service === "animego" ? findAnimeGoActiveEpisode() : null;
    const activeYummyEpisode = service === "yummyanime"
      ? Array.from(document.querySelectorAll('[data-selected="1"]'))
        .map((element) => String(element.textContent || "").trim())
        .find((value) => /^\d{1,4}$/.test(value))
      : null;
    const episodeCandidates = [
      ...episodeSelectors.map(textFrom),
      document.title,
      ...Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8).map((el) => el.textContent || ""),
      location.pathname,
    ];
    let episode = activeAnimeGoEpisode || (activeYummyEpisode ? Number(activeYummyEpisode) : null);
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

  // CVH nests its player iframe inside the open shadow root of <video-player>.
  // document.querySelectorAll() does not cross shadow DOM boundaries, so walk
  // open roots when locating the child frame that requested AnimeGO metadata.
  function queryAllDeep(selector, root = document) {
    const matches = [];
    if (!root || typeof root.querySelectorAll !== "function") return matches;
    matches.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) matches.push(...queryAllDeep(selector, element.shadowRoot));
    }
    return matches;
  }

  function sendParentMetadataToFrame(frame) {
    if ((service !== "animego" && service !== "yummyanime") || (isAnimeGoPlayerFrame && !isCvhFrame) || !frame?.contentWindow) return;
    let frameUrl;
    try {
      frameUrl = new URL(frame.src, location.href);
    } catch {
      return;
    }
    const targetHost = frameUrl.hostname.toLowerCase();
    const isAniBoomTarget = targetHost === "aniboom.one";
    // AnimeGO does not consistently expose providerSlug on its iframe.
    // The CVH iframe URL itself is the stable provider signal.
    const isCvhTarget = targetHost === "animego.me" && frameUrl.pathname.startsWith("/cdn-iframe/");
    const isCvhPlayerTarget = targetHost === "player.cdnvideohub.com";
    const isKodikTarget = targetHost === "kodikplayer.com";
    if (!isAniBoomTarget && !isCvhTarget && !isCvhPlayerTarget && !isKodikTarget) return;
    if ((isAniBoomTarget || isCvhTarget || isCvhPlayerTarget) && service !== "animego") return;

    const detected = detect();
    if (!detected.title || !Number.isSafeInteger(detected.episode) || detected.episode < 1) return;
    frame.contentWindow.postMessage({
      type: "MIDAHOSHI_PARENT_METADATA",
      metadata: {
        title: detected.title,
        episode: detected.episode,
        sourceUrl: detected.sourceUrl,
        service: detected.service,
      },
    }, frameUrl.origin);
  }

  function syncParentMetadataToFrames() {
    if ((service !== "animego" && service !== "yummyanime") || (isAnimeGoPlayerFrame && !isCvhFrame)) return;
    queryAllDeep("iframe").forEach(sendParentMetadataToFrame);
  }

  let parentMetadataRetryTimer = null;

  if (isAnimeGoPlayerFrame) {
    const requestParentMetadata = () => {
      if (!parentMetadata) {
        // Player frames can load before the parent content script. Retry until
        // AnimeGO responds instead of losing the one-time startup handshake.
        window.parent.postMessage(
          { type: "MIDAHOSHI_REQUEST_PARENT_METADATA" },
          isCvhPlayerFrame ? "https://animego.me" : isCvhFrame ? location.origin : "*",
        );
      } else if (parentMetadataRetryTimer !== null) {
        window.clearInterval(parentMetadataRetryTimer);
        parentMetadataRetryTimer = null;
      }
    };

    window.addEventListener("message", (event) => {
      const validParentOrigin = isKodikFrame
        ? isAllowedWatchSourceUrl(event.origin)
        : isAllowedAnimeGoUrl(event.origin);
      if (event.source !== window.parent || !validParentOrigin) return;
      if (event.data?.type !== "MIDAHOSHI_PARENT_METADATA") return;
      const metadata = event.data.metadata;
      if (
        !metadata ||
        typeof metadata.title !== "string" ||
        metadata.title.trim().length < 2 ||
        !Number.isSafeInteger(metadata.episode) ||
        metadata.episode < 1 ||
        !isAllowedWatchSourceUrl(metadata.sourceUrl) ||
        new URL(metadata.sourceUrl).origin !== event.origin ||
        (isKodikFrame && metadata.service !== "animego" && metadata.service !== "yummyanime")
      ) return;
      const sourceUrl = new URL(metadata.sourceUrl);
      const nextMetadata = {
        title: metadata.title.trim(),
        episode: metadata.episode,
        sourceUrl: sourceUrl.origin + sourceUrl.pathname,
        service: isKodikFrame ? metadata.service : "animego",
      };
      const nextMetadataKey = [
        nextMetadata.title.trim().toLocaleLowerCase(),
        nextMetadata.episode,
        nextMetadata.sourceUrl,
      ].join("|");
      if (isAniBoomFrame && aniboomMetadataKey !== null && aniboomMetadataKey !== nextMetadataKey) {
        // AniBoom can briefly keep the previous episode's near-end timestamp
        // after AnimeGO has already switched the parent episode metadata.
        previousAniBoomTime = null;
        aniboomAwaitingEpisodeStart = true;
      }
      if (isAniBoomFrame) aniboomMetadataKey = nextMetadataKey;
      if (isKodikFrame && kodikMetadataKey !== null && kodikMetadataKey !== nextMetadataKey) {
        // A reused Kodik player may briefly retain the previous episode's
        // playback position after the parent page changes episode metadata.
        previousKodikTime = null;
        kodikAwaitingEpisodeStart = true;
      }
      if (isKodikFrame) kodikMetadataKey = nextMetadataKey;
      if (isCvhPlayerFrame && cvhMetadataKey !== null && cvhMetadataKey !== nextMetadataKey) {
        // The CVH player can briefly report the previous episode's near-end
        // timestamp after AnimeGO has already switched the episode metadata.
        // Do not attribute that stale playback position to the new episode.
        previousCvhTime = null;
        cvhAwaitingEpisodeStart = true;
      }
      cvhMetadataKey = nextMetadataKey;
      parentMetadata = nextMetadata;
      requestParentMetadata();
      scanVideos();
      if (isCvhFrame) syncParentMetadataToFrames();
      if (isCvhTrackingFrame) maybeSendCvhSample();
    });

    if (isCvhPlayerFrame) {
      window.addEventListener("message", (event) => {
        if (event.source !== window || event.origin !== location.origin ||
            event.data?.type !== "MIDAHOSHI_CVH_STATE") return;
        const sample = event.data.state;
        if (!sample ||
            !Number.isFinite(sample.currentTime) ||
            !Number.isFinite(sample.duration) ||
            sample.currentTime < 0 ||
            sample.duration <= 0 ||
            typeof sample.paused !== "boolean" ||
            !Number.isFinite(sample.readyState)) return;
        latestCvhSample = sample;
        maybeSendCvhSample();
      });
    }

    if (isCvhFrame) {
      window.addEventListener("message", (event) => {
        if (event.source === window.parent ||
            event.origin !== "https://player.cdnvideohub.com" ||
            event.data?.type !== "MIDAHOSHI_REQUEST_PARENT_METADATA") return;
        const frame = queryAllDeep("iframe")
          .find((candidate) => candidate.contentWindow === event.source);
        if (frame) sendParentMetadataToFrame(frame);
      });
    }

    requestParentMetadata();
    parentMetadataRetryTimer = window.setInterval(requestParentMetadata, 750);
  } else {
    window.addEventListener("message", (event) => {
      if (event.origin !== "https://aniboom.one" &&
          event.origin !== "https://kodikplayer.com" &&
          event.origin !== location.origin) return;
      if (event.data?.type !== "MIDAHOSHI_REQUEST_PARENT_METADATA") return;
      const frame = queryAllDeep("iframe")
        .find((candidate) => candidate.contentWindow === event.source);
      if (frame) sendParentMetadataToFrame(frame);
    });
  }

  function maybeSendCvhSample() {
    if (!isCvhPlayerFrame || !parentMetadata || !latestCvhSample) return;
    const { currentTime, duration, paused, readyState } = latestCvhSample;
    if (paused || readyState < 2) {
      previousCvhTime = null;
      return;
    }
    const previousTime = previousCvhTime;
    previousCvhTime = currentTime;

    if (cvhAwaitingEpisodeStart) {
      // A new episode is not considered active until its playback timeline
      // visibly resets. This filters stale near-end samples carried over from
      // the previous episode when the same CVH player is reused.
      const timelineReset = currentTime <= Math.min(10, duration * 0.02) ||
        (previousTime !== null && currentTime < previousTime - 5);
      if (timelineReset) {
        cvhAwaitingEpisodeStart = false;
        previousCvhTime = currentTime;
      }
      return;
    }

    // Require real forward playback between consecutive samples. This avoids
    // treating a seek, paused position, or a page restored near the end as a watch.
    const delta = previousTime === null ? 0 : currentTime - previousTime;
    if (delta < 0 || delta > 5 || delta < 0.15) return;
    if (currentTime / duration < 0.9) return;

    const detected = detect();
    if (!detected.title || !Number.isSafeInteger(detected.episode) || detected.episode < 1) return;

    const eventKey = [detected.sourceUrl, detected.episode].join("|");
    if (sentCvhKeys.has(eventKey)) return;
    sentCvhKeys.add(eventKey);

    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        ...detected,
        eventId: crypto.randomUUID(),
        observedAt: new Date().toISOString(),
      },
    });
  }

  function maybeSendAniBoomVideo(video) {
    if (!isAniBoomFrame || !parentMetadata) return;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(currentTime) || currentTime < 0 || video.paused === true) {
      previousAniBoomTime = null;
      return;
    }

    const previousTime = previousAniBoomTime;
    previousAniBoomTime = currentTime;
    if (aniboomAwaitingEpisodeStart) {
      // Do not attribute the previous episode's position to the new episode.
      // Wait until AniBoom visibly resets its timeline before counting playback.
      const timelineReset = currentTime <= Math.min(10, duration * 0.02) ||
        (previousTime !== null && currentTime < previousTime - 5);
      if (timelineReset) {
        aniboomAwaitingEpisodeStart = false;
        previousAniBoomTime = currentTime;
      }
      return;
    }

    const delta = previousTime === null ? 0 : currentTime - previousTime;
    if (delta < 0.15 || delta > 5 || currentTime / duration < 0.9) return;

    const detected = detect(video);
    if (detected.manualOnly || !detected.title ||
        !Number.isSafeInteger(detected.episode) || detected.episode < 1) return;
    const eventKey = [
      detected.sourceUrl,
      detected.episode,
      video.currentSrc || video.src || "",
    ].join("|");
    if (sentAniBoomKeys.has(eventKey)) return;
    sentAniBoomKeys.add(eventKey);

    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        ...detected,
        currentTimeSeconds: Math.floor(currentTime),
        durationSeconds: Math.floor(duration),
        hasVideoElement: true,
        manualOnly: false,
        eventId: crypto.randomUUID(),
        observedAt: new Date().toISOString(),
      },
    });
  }

  function maybeSendKodikVideo(video) {
    if (!isKodikFrame || !parentMetadata) return;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(currentTime) || currentTime < 0 || video.paused === true) {
      previousKodikTime = null;
      return;
    }

    const previousTime = previousKodikTime;
    previousKodikTime = currentTime;
    if (kodikAwaitingEpisodeStart) {
      const timelineReset = currentTime <= Math.min(10, duration * 0.02) ||
        (previousTime !== null && currentTime < previousTime - 5);
      if (timelineReset) {
        kodikAwaitingEpisodeStart = false;
        previousKodikTime = currentTime;
      }
      return;
    }

    const delta = previousTime === null ? 0 : currentTime - previousTime;
    if (delta < 0.15 || delta > 5 || currentTime / duration < 0.9) return;

    const detected = detect(video);
    if (!detected.title || !Number.isSafeInteger(detected.episode) || detected.episode < 1) return;
    const eventKey = [detected.sourceUrl, detected.episode, video.currentSrc || video.src || ""].join("|");
    if (sentKodikKeys.has(eventKey)) return;
    sentKodikKeys.add(eventKey);

    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        ...detected,
        currentTimeSeconds: Math.floor(currentTime),
        durationSeconds: Math.floor(duration),
        hasVideoElement: true,
        manualOnly: false,
        eventId: crypto.randomUUID(),
        observedAt: new Date().toISOString(),
      },
    });
  }

  function attachVideo(video) {
    const existingHandler = videoWatchHandlers.get(video);
    if (existingHandler) {
      // Metadata may arrive after the video has already reached 90% or ended.
      // Recheck on every scan so late parent metadata cannot miss the event.
      existingHandler();
      return;
    }

    const maybeSend = () => {
      if (isKodikFrame) {
        maybeSendKodikVideo(video);
        return;
      }
      if (isAniBoomFrame) {
        maybeSendAniBoomVideo(video);
        return;
      }
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

    videoWatchHandlers.set(video, maybeSend);
    video.addEventListener("timeupdate", maybeSend, { passive: true });
    video.addEventListener("ended", maybeSend, { passive: true });
    // Also handle videos that were already past the threshold before metadata
    // or the event listeners became available.
    maybeSend();
  }

  function scanVideos() {
    publishCurrentWatchContext();
    if (isCvhTrackingFrame) {
      maybeSendCvhSample();
      return;
    }
    const mainVideo = findMainVideo();
    if (mainVideo) attachVideo(mainVideo);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MIDAHOSHI_REFRESH_WATCH_CONTEXT" && !isAnimeGoPlayerFrame) {
      lastPublishedContextKey = "";
      publishCurrentWatchContext();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "MIDAHOSHI_DETECT_WATCH_EVENT" && !isAnimeGoPlayerFrame) {
      sendResponse(detect());
    }
    return true;
  });

  scanVideos();
  syncParentMetadataToFrames();
  const observer = new MutationObserver(() => {
    scanVideos();
    syncParentMetadataToFrames();
  });
  const observerOptions = {
    childList: true,
    subtree: true,
    ...(!isAnimeGoPlayerFrame ? {
      attributes: true,
      // YummyAnime marks the selected episode with data-selected="1".
      // Observe attribute changes so switching episodes republishes metadata
      // to embedded players without requiring a full page reload.
      attributeFilter: ["class", "data-episode-number", "data-selected", "src"],
    } : {}),
  };
  observer.observe(document.documentElement, observerOptions);
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
})();