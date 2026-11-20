(() => {
  // Read only public, non-secret catalog metadata exposed by AnixART's page player.
  // Never forward cvhId, vkId, URLs, tokens, cookies, or stream resources.
  const host = location.hostname.toLowerCase();
  if (host !== "anixart.site" && !host.endsWith(".anixart.site")) return;

  let lastCatalogFingerprint = "";
  let lastCatalogSentAt = 0;

  function buildCatalog(state) {
    const seasons = [];
    const sourceSeasons = state?.seasons;
    if (!sourceSeasons || typeof sourceSeasons !== "object") return null;

    for (const [seasonKey, seasonValue] of Object.entries(sourceSeasons).slice(0, 50)) {
      const seasonNumber = Number(seasonValue?.name ?? seasonKey);
      if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1) continue;
      const episodes = [];
      const sourceEpisodes = seasonValue?.episodes;
      if (!sourceEpisodes || typeof sourceEpisodes !== "object") continue;

      for (const [episodeKey, episodeValue] of Object.entries(sourceEpisodes).slice(0, 500)) {
        const episodeNumber = Number(episodeValue?.name ?? episodeKey);
        if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) continue;
        const voices = [];
        const sourceVoices = episodeValue?.voices;
        if (sourceVoices && typeof sourceVoices === "object") {
          for (const [voiceName, voiceValue] of Object.entries(sourceVoices).slice(0, 100)) {
            let name = String(voiceValue?.name ?? voiceName).trim().slice(0, 100);
            if (!name) continue;
            const videos = Array.isArray(voiceValue?.videos) ? voiceValue.videos : [];
            const matching = videos.find(video =>
              Number(video?.season) === seasonNumber &&
              Number(video?.episode) === episodeNumber &&
              String(video?.voiceStudio ?? name) === name
            );
            let type = typeof matching?.voiceType === "string" ? matching.voiceType.trim().slice(0, 60) : "";
            if (/^субтитры$/i.test(name) && !type) {
              name = "Студия не указана";
              type = "Субтитры";
            }
            voices.push({ name, type: type || null });
          }
        }
        const uniqueVoices = [...new Map(voices.map(voice => [voice.name.toLocaleLowerCase() + "\\u0000" + String(voice.type || "").toLocaleLowerCase(), voice])).values()];
        episodes.push({ number: episodeNumber, title: String(episodeValue?.visibleName ?? episodeNumber).slice(0, 120), voices: uniqueVoices });
      }
      episodes.sort((a, b) => a.number - b.number);
      seasons.push({ number: seasonNumber, episodes });
    }
    seasons.sort((a, b) => a.number - b.number);
    if (!seasons.length) return null;

    const title = (document.querySelector("h1")?.textContent || document.title || "")
      .replace(/\s*[|·-]\s*Anixart.*$/i, "").trim().slice(0, 200);
    const slug = location.pathname.split("/").filter(Boolean).at(-1) || "";
    if (!/^\d+-[\p{L}\p{N}-]+\.html$/u.test(slug) || title.length < 2) return null;

    return {
      slug,
      title,
      seasons,
      current: {
        season: Number.isSafeInteger(Number(state?.currentVideo?.season)) ? Number(state.currentVideo.season) : null,
        episode: Number.isSafeInteger(Number(state?.currentVideo?.episode)) ? Number(state.currentVideo.episode) : null,
        voice: typeof state?.currentVideo?.voiceStudio === "string" ? state.currentVideo.voiceStudio.slice(0, 100) : null
      }
    };
  }

  const samplePlayer = () => {
    const element = document.querySelector("video-player");
    const state = element?.state;
    if (!state) return;

    // The season/episode catalog can be ready before the user starts a video.
    // Publish it independently from current playback state.
    const video = state.currentVideo;
    if (video && typeof video === "object") {
      const episode = Number(video.episode ?? state.currentEpisode?.name);
      const season = Number(video.season ?? state.currentSeason?.name);
      const currentTime = Number(state.position);
      const duration = Number(state.duration);
      const playing = state.playing === true;

      if (Number.isSafeInteger(episode) && episode > 0 &&
          Number.isFinite(currentTime) && currentTime >= 0 &&
          Number.isFinite(duration) && duration > 0) {
        const voice = typeof video.voiceStudio === "string"
          ? video.voiceStudio.slice(0, 100)
          : typeof state.currentVoice?.name === "string"
            ? state.currentVoice.name.slice(0, 100)
            : null;
        window.postMessage({
          type: "MIDAHOSHI_ANIXART_STATE",
          state: {
            season: Number.isSafeInteger(season) && season > 0 ? season : null,
            episode, voice, currentTime, duration, playing
          }
        }, location.origin);
      }
    }

    const catalog = buildCatalog(state);
    if (!catalog) return;
    const fingerprint = JSON.stringify(catalog);
    const now = Date.now();
    if (fingerprint === lastCatalogFingerprint && now - lastCatalogSentAt < 15000) return;
    lastCatalogFingerprint = fingerprint;
    lastCatalogSentAt = now;
    window.postMessage({ type: "MIDAHOSHI_ANIXART_CATALOG", catalog }, location.origin);
  };

  samplePlayer();
  const timer = window.setInterval(samplePlayer, 3000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
})();
