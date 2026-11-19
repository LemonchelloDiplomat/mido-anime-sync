(() => {
  // Runs only inside AnimeGO's CVH iframe. Read-only access to the player's
  // public API is used; no storage, credentials, network, or player controls.
  if (location.hostname !== "animego.me" || !location.pathname.startsWith("/cdn-iframe/")) return;

  const samplePlayer = () => {
    const player = document.querySelector("#pcvh");
    if (!player?.api || !player.state) return;

    try {
      const currentTime = Number(player.api.getCurrentTime());
      const duration = Number(player.api.getDuration());
      const rawEpisode = player.state.currentEpisode?.name ?? player.getAttribute("episode");
      const episode = Number(rawEpisode);

      if (!Number.isFinite(currentTime) || currentTime < 0 ||
          !Number.isFinite(duration) || duration <= 0 ||
          !Number.isSafeInteger(episode) || episode < 1) return;

      window.postMessage({
        type: "MIDAHOSHI_CVH_STATE",
        state: { currentTime, duration, episode },
      }, location.origin);
    } catch {
      // The player may be initializing or replacing its internal state.
    }
  };

  samplePlayer();
  const timer = window.setInterval(samplePlayer, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
