(() => {
  // CVH hosts its player on player.cdnvideohub.com. The native video is
  // exposed through the VK player's internal open shadow root.
  if (location.hostname !== "player.cdnvideohub.com") return;

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
