(() => {
  const hostnames = new Set(["animego.lt", "www.animego.lt", "animego.name", "www.animego.name"]);
  if (!hostnames.has(location.hostname.toLowerCase())) return;

  window.__MIDA_WATCH_ADAPTERS = window.__MIDA_WATCH_ADAPTERS || [];
  window.__MIDA_WATCH_ADAPTERS.push({
    service: "animego",
    matches: () => hostnames.has(location.hostname.toLowerCase()),
    titleSelectors: ["meta[property='og:title']", "h1", ".anime-title", "[itemprop='name']"],
    episodeSelectors: ["[data-episode-number]", "[data-episode]", ".current-episode", ".episode-number"],
    titleSuffix: /\s*[|•-]\s*AnimeGO\s*$/i,
  });
})();