(() => {
  const hostnames = new Set(["yummyani.me", "www.yummyani.me", "yummy-ani.me", "www.yummy-ani.me"]);
  if (!hostnames.has(location.hostname.toLowerCase())) return;

  window.__MIDA_WATCH_ADAPTERS = window.__MIDA_WATCH_ADAPTERS || [];
  window.__MIDA_WATCH_ADAPTERS.push({
    service: "yummyanime",
    matches: () => hostnames.has(location.hostname.toLowerCase()),
    titleSelectors: ["meta[property='og:title']", "h1", "[itemprop='name']"],
    episodeSelectors: ["[data-episode-number]", "[data-episode]", ".current-episode", ".episode-number"],
    titleSuffix: /\s*[|•-]\s*YummyAnime\s*$/i,
  });
})();