(() => {
  // Read only playback position metadata from the public AnixART page player.
  const host = location.hostname.toLowerCase();
  if (host !== "anixart.site" && !host.endsWith(".anixart.site")) return;

  const samplePlayer = () => {
    const element = document.querySelector("video-player");
    const state = element?.state;
    const video = state?.currentVideo;
    if (!state || !video || typeof video !== "object") return;

    const episode = Number(video.episode ?? state.currentEpisode?.name);
    const season = Number(video.season ?? state.currentSeason?.name);
    const currentTime = Number(state.position);
    const duration = Number(state.duration);
    if (!Number.isSafeInteger(episode) || episode < 1 ||
        !Number.isFinite(currentTime) || currentTime < 0 ||
        !Number.isFinite(duration) || duration <= 0) return;

    const voice = typeof video.voiceStudio === "string"
      ? video.voiceStudio.slice(0, 100)
      : typeof state.currentVoice?.name === "string"
        ? state.currentVoice.name.slice(0, 100)
        : null;
    window.postMessage({
      type: "MIDAHOSHI_ANIXART_STATE",
      state: {
        season: Number.isSafeInteger(season) && season > 0 ? season : null,
        episode,
        voice,
        currentTime,
        duration,
        playing: state.playing === true,
      },
    }, location.origin);
  };

  samplePlayer();
  const timer = window.setInterval(samplePlayer, 1000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
