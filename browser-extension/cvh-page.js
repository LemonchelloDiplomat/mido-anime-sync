(() => {
  // AnimeGO's CVH player is a page custom element. Its internal _shadowRoot
  // contains the native video element, so sample only playback state here.
  // CVH is embedded by AnimeGO at /cdn-iframe/<id>/...; the native player
  // lives in that iframe, not in the AnimeGO catalogue document.
  if (location.hostname !== "animego.me" || !location.pathname.startsWith("/cdn-iframe/")) return;

  const numericPathParts = location.pathname.split("/").filter(Boolean).slice(2)
    .filter((part) => /^\\d+$/.test(part));
  const episode = Number(numericPathParts[numericPathParts.length - 1]);
  if (!Number.isSafeInteger(episode) || episode < 1) return;

  let lastVideo = null;

  const samplePlayer = () => {
    const player = document.querySelector("vk-video-player");
    const video = player?._shadowRoot?.querySelector("video");
    if (!video) {
      lastVideo = null;
      return;
    }

    if (video !== lastVideo) lastVideo = video;

    const currentTime = Number(video.currentTime);
    const duration = Number(video.duration);
    const readyState = Number(video.readyState);
    if (!Number.isFinite(currentTime) || currentTime < 0 ||
        !Number.isFinite(duration) || duration <= 0) return;

    window.postMessage({
      type: "MIDAHOSHI_CVH_STATE",
      state: {
        episode,
        currentTime,
        duration,
        paused: Boolean(video.paused),
        readyState,
      },
    }, location.origin);
  };

  samplePlayer();
  const timer = window.setInterval(samplePlayer, 1000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
