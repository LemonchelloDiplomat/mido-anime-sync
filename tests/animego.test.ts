import { describe, expect, it, vi } from "vitest";
import {
  handleAnimeGoRequest,
  parseAnimeGoDetail,
  parseAnimeGoPlayer,
  parseAnimeGoSearch,
  parseAnimeGoVoices,
  resolve4Async,
} from "../server/animego-routes.mjs";

function responseCapture(): { status: number; body: string; writeHead(status: number): void; end(body?: string): void; json(): any } {
  return {
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; },
    end(body = "") { this.body = body; },
    json() { return JSON.parse(this.body); },
  };
}

const searchHtml = `
<nav class="sidebar">
  <a href="/anime/top-250">Топ 250</a>
  <a href="/anime/ongoing">Онгоинг</a>
  <a href="/anime/season-2026">2026</a>
  <a href="/anime/random">Случайное аниме</a>
</nav>
<div class="grid ani-list">
  <div class="ani-grid__item ani-grid__item-picture">
    <a class="ani-grid__item-picture" href="/anime/sample-title-1234"><img class="image__img" src="/uploads/sample.jpg" alt="Sample Anime"></a>
    <div class="ani-grid__item-title"><a href="/anime/sample-title-1234">Sample Anime</a></div>
  </div>
  <div class="ani-grid__item">
    <a title="Another Anime" href="/anime/another-title-5678"><img src="/uploads/another.jpg" alt="Another Anime"></a>
  </div>
</div>`;

const detailHtml = `
<link rel="canonical" href="https://animego.me/anime/sample-title-1234">
<meta property="og:image" content="https://animego.me/poster.jpg">
<meta name="description" content="A sample synopsis">
<h1>Sample Anime</h1>
<script type="application/ld+json">{"datePublished":"2024-01-01","alternateName":"Sample JP","genre":["Action","Drama"],"numberOfEpisodes":12,"aggregateRating":{"ratingValue":8.2}}</script>`;

describe("AnimeGO DNS adapter", () => {
  it("wraps Node Resolver.resolve4 callback in a promise", async () => {
    const resolver = {
      resolve4: vi.fn((_hostname: string, callback: (error: Error | null, addresses?: string[]) => void) => {
        callback(null, ["185.178.208.182"]);
      }),
    };
    await expect(resolve4Async(resolver as any, "animego.me")).resolves.toEqual(["185.178.208.182"]);
    expect(resolver.resolve4).toHaveBeenCalledWith("animego.me", expect.any(Function));
  });

  it("propagates DNS resolver errors", async () => {
    const failure = new Error("DNS unavailable");
    const resolver = {
      resolve4: vi.fn((_hostname: string, callback: (error: Error | null, addresses?: string[]) => void) => {
        callback(failure);
      }),
    };
    await expect(resolve4Async(resolver as any, "animego.me")).rejects.toBe(failure);
  });
});

describe("AnimeGO public catalog adapter", () => {
  it("parses only actual search cards and ignores AnimeGO navigation links", () => {
    const items = parseAnimeGoSearch(searchHtml);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title)).toEqual(["Sample Anime", "Another Anime"]);
    expect(items.map((item) => item.externalId)).toEqual(["sample-title-1234", "another-title-5678"]);
    expect(items[0]).toMatchObject({
      provider: "animego",
      externalId: "sample-title-1234",
      title: "Sample Anime",
      url: "https://animego.me/anime/sample-title-1234",
      posterUrl: "https://animego.me/uploads/sample.jpg",
    });
  });

  it("ranks the matching romanized title above unrelated AnimeGO results", async () => {
    const relevantHtml = '<div class="ani-grid__item"><a title="Shunkashuutou Daikousha: Haru no Mai" href="/anime/shunkashuutou-daikousha-haru-no-mai-9001"><img alt="Agents of the Four Seasons: Dance of Spring" src="/spring.jpg"></a></div><div class="ani-grid__item"><a title="K-On!" href="/anime/k-on-9002"><img alt="K-On!" src="/kon.jpg"></a></div>';
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, async text() { return relevantHtml; } }));
    const deps = { request: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const response = responseCapture();
    await handleAnimeGoRequest({ method: "GET" }, response, new URL("http://127.0.0.1/api/animego/search?q=Shunkashuutou+Daikousha%3A+Haru+no+Mai"), deps);
    expect(response.status).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].title).toBe("Shunkashuutou Daikousha: Haru no Mai");
  });
  it("parses public title metadata and exact AnimeGO identity", () => {
    const title = parseAnimeGoDetail(detailHtml, "https://animego.me/anime/sample-title-1234");
    expect(title).toMatchObject({
      provider: "animego",
      externalId: "1234",
      title: "Sample Anime",
      year: 2024,
      episodeCount: 12,
    });
    expect(title.identity.externalIds.animego).toBe("1234");
    expect(title.identity.genres).toEqual(["Action", "Drama"]);
  });

  it("parses episode IDs and provider-specific player embeds", () => {
    const payload = {
      data: {
        content: `
          <div class="player-video-bar__item" data-episode-number="1" data-episode-title="First" data-episode="555"></div>
          <div class="player-video-bar__item" data-episode="556" data-episode-number="2" data-episode-title="Second"></div>
          <button data-player="//kodikplayer.com/seria/123/hash/720p" data-translation-title="Studio Example" data-provider-title="Kodik" data-ptranslation="22">Play</button>
          <button data-player="https://aniboom.one/embed/abc?episode=1" data-translation-title="Dub Two (ошибка)" data-provider-title="AniBoom" data-ptranslation="23">Play</button>
          <button data-translation-title="Not a player" data-provider-title="Unknown">Skip</button>
        `,
      },
    };
    const parsed = parseAnimeGoPlayer(payload, "https://animego.me/anime/sample-title-1234");
    expect(parsed.episodes.map((episode) => episode.number)).toEqual([1, 2]);
    expect(parsed.episodes.map((episode) => episode.externalId)).toEqual(["555", "556"]);
    expect(parsed.voices).toHaveLength(2);
    expect(parsed.voices[0]).toMatchObject({
      name: "Studio Example",
      playerName: "Kodik",
      playerUrl: "https://kodikplayer.com/seria/123/hash/720p",
    });
    expect(parsed.voices[1]).toMatchObject({ name: "Dub Two", playerName: "AniBoom" });
    expect(parseAnimeGoVoices(payload)).toEqual(parsed.voices);
  });

  it("proxies catalog search through the local server and declares account sync unsupported", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() { return searchHtml; },
    }));
    const deps = { request: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const searchResponse = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" },
      searchResponse,
      new URL("http://127.0.0.1/api/animego/search?q=sample"),
      deps,
    );
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.json().items[0].title).toBe("Sample Anime");

    const statusResponse = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" },
      statusResponse,
      new URL("http://127.0.0.1/api/animego/status"),
      deps,
    );
    expect(statusResponse.json()).toMatchObject({
      catalogSearch: true,
      accountConnection: false,
      listImport: false,
      watchProgressRead: "browser-extension",
    });
  });
  it("retries AnimeGO search on the alternate route when the primary route returns 404", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, async text() { return ""; } })
      .mockResolvedValueOnce({ ok: true, status: 200, async text() { return searchHtml; } });
    const deps = { request: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const response = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1/api/animego/search?q=Shunkashuutou+Daikousha%3A+Haru+no+Mai"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://animego.me/search/anime?q=Shunkashuutou+Daikousha%3A+Haru+no+Mai",
      expect.anything(),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://animego.me/search/all?q=Shunkashuutou+Daikousha%3A+Haru+no+Mai",
      expect.anything(),
    );
  });

  it("loads player embeds for an individual episode through the local proxy", async () => {
    const payload = {
      data: {
        content: '<button data-player="https://kodikplayer.com/seria/123/hash/720p" data-translation-title="Studio" data-provider-title="Kodik" data-ptranslation="7">Play</button>',
      },
    };
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => ({
      ok: true,
      status: 200,
      async json() { return payload; },
      async text() { return ""; },
      options,
    }));
    const deps = { request: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const response = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1/api/animego/episode/555"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.json().voices[0]).toMatchObject({
      name: "Studio",
      playerName: "Kodik",
      playerUrl: "https://kodikplayer.com/seria/123/hash/720p",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://animego.me/player/videos/555",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Requested-With": "XMLHttpRequest" }) }),
    );
  });

});
