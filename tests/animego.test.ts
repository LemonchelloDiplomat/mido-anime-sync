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

  it("extracts posters from lazy-loaded attributes, srcset, and CSS backgrounds", () => {
    const html = `
      <div class="ani-grid__item">
        <div class="ani-grid__item-picture">
          <a href="/anime/nested-poster-1000"><img alt="" loading="lazy" src="https://img.cdngos.com/v/250x350/anime/69/69d16a4ca28d1312818966"></a>
        </div>
        <div class="ani-grid__item-title"><a title="Nested poster" href="/anime/nested-poster-1000">Nested poster</a></div>
      </div>
      <div class="ani-grid__item">
        <a title="Lazy poster" href="/anime/lazy-poster-1001">
          <img data-original="//cdn.example/lazy.jpg" src="data:image/gif;base64,placeholder" alt="Lazy poster">
        </a>
      </div>
      <div class="ani-grid__item">
        <a title="Srcset poster" href="/anime/srcset-poster-1002">
          <picture><source srcset="/small.jpg 320w, /large.jpg 900w"><img alt="Srcset poster"></picture>
        </a>
      </div>
      <div class="ani-grid__item">
        <a title="Background poster" href="/anime/background-poster-1003">
          <div style="background-image: url('/background.jpg')"></div>
        </a>
      </div>`;
    expect(parseAnimeGoSearch(html).map((item) => item.posterUrl)).toEqual([
      "https://img.cdngos.com/v/250x350/anime/69/69d16a4ca28d1312818966",
      "https://cdn.example/lazy.jpg",
      "https://animego.me/large.jpg",
      "https://animego.me/background.jpg",
    ]);
  });

  it("extracts poster URLs from unquoted lazy attributes and non-image background wrappers", () => {
    const html = `
      <div class="ani-grid__item">
        <a href="/anime/unquoted-lazy-2001"><div class="ani-grid__item-picture"><img data-src=https://img.cdngos.com/posters/unquoted.jpg alt="Unquoted"></div></a>
      </div>
      <div class="ani-grid__item">
        <a href="/anime/background-data-2002"><div class="poster" data-bg="https://img.cdngos.com/posters/background.jpg"></div></a>
      </div>
      <div class="ani-grid__item">
        <a href="/anime/style-background-2003"><div class="poster" style="background-image:url(https://img.cdngos.com/posters/style.jpg)"></div></a>
      </div>
    `;
    expect(parseAnimeGoSearch(html).map((item) => item.posterUrl)).toEqual([
      "https://img.cdngos.com/posters/unquoted.jpg",
      "https://img.cdngos.com/posters/background.jpg",
      "https://img.cdngos.com/posters/style.jpg",
    ]);
  });

  it("keeps Japanese search text intact when ranking AnimeGO results", async () => {
    const html = '<div class="ani-grid__item"><a title="葬送のフリーレン" href="/anime/sousou-no-frieren-9003"><img alt="葬送のフリーレン" src="/frieren.jpg"></a></div>';
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, async text() { return html; } }));
    const response = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" }, response,
      new URL("http://127.0.0.1/api/animego/search?q=" + encodeURIComponent("葬送のフリーレン")),
      { request: fetcher, sendJson(res: any, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } },
    );
    expect(response.status).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].title).toBe("葬送のフリーレン");
  });

  it("applies a bounded abort signal to poster CDN requests", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200, headers: { "Content-Type": "image/jpeg" },
      });
    });
    const response = responseCapture();
    await handleAnimeGoRequest(
      { method: "GET" }, response,
      new URL("http://127.0.0.1/api/animego/poster?url=" + encodeURIComponent("https://img.cdngos.com/test.jpg")),
      { fetch: fetcher, sendJson(res: any, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } },
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
  it("serves AnimeGO poster images through a same-origin local proxy", async () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetcher = vi.fn(async () => new Response(imageBytes, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    }));
    const response = {
      status: 0,
      headers: {} as Record<string, string>,
      body: Buffer.alloc(0),
      writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headers = headers; },
      end(body: Buffer | string = "") { this.body = Buffer.isBuffer(body) ? body : Buffer.from(body); },
    };
    await handleAnimeGoRequest(
      { method: "GET" }, response,
      new URL("http://127.0.0.1/api/animego/poster?url=" + encodeURIComponent("https://img.cdngos.com/v/250x350/anime/test")),
      {
        fetch: fetcher,
        sendJson(res: any, status: number, body: unknown) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toBe("image/jpeg");
    expect(response.body).toEqual(Buffer.from(imageBytes));
    expect(fetcher).toHaveBeenCalledWith(
      "https://img.cdngos.com/v/250x350/anime/test",
      expect.objectContaining({ headers: expect.objectContaining({ Referer: "https://animego.me/" }) }),
    );
  });

  it("rejects poster proxy URLs outside the trusted AnimeGO image hosts", async () => {
    const response = responseCapture();
    const fetcher = vi.fn();
    await handleAnimeGoRequest(
      { method: "GET" }, response,
      new URL("http://127.0.0.1/api/animego/poster?url=" + encodeURIComponent("https://evil.example/image.jpg")),
      {
        fetch: fetcher,
        sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); },
      },
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries AnimeGO search on the alternate route when the primary route returns 404", async () => {
    const fallbackSearchHtml = `
      <div class="ani-grid__item">
        <a title="Shunkashuutou Daikousha: Haru no Mai" href="/anime/shunkashuutou-haru-9001"><img alt="Agents of the Four Seasons" src="/spring.jpg"></a>
      </div>
      <div class="ani-grid__item">
        <a title="Shunkashuutou Daikousha" href="/anime/shunkashuutou-9002"><img alt="Four Seasons" src="/seasons.jpg"></a>
      </div>`;
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, async text() { return ""; } })
      .mockResolvedValueOnce({ ok: true, status: 200, async text() { return fallbackSearchHtml; } });
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

  it("exposes AnimeGO movie player variants as a synthetic film episode", async () => {
    const filmHtml = '<link rel="canonical" href="https://animego.me/anime/naruto-posledniy-film-387"><h1>Наруто: Последний фильм</h1>';
    const playerPayload = { data: { content: '<button data-player="https://kodikplayer.com/seria/film387" data-translation-title="AniDUB" data-provider-title="Kodik" data-ptranslation="77">Play</button>' } };
    const fetcher = vi.fn(async (url: string) => url.includes("/player/")
      ? { ok: true, status: 200, async json() { return playerPayload; }, async text() { return ""; } }
      : { ok: true, status: 200, async text() { return filmHtml; }, async json() { return {}; } });
    const deps = { request: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const response = responseCapture();
    await handleAnimeGoRequest({ method: "GET" }, response, new URL("http://127.0.0.1/api/animego/anime/naruto-posledniy-film-387"), deps);
    expect(response.status).toBe(200);
    expect(response.json().seasons[0].episodes).toHaveLength(1);
    expect(response.json().seasons[0].episodes[0]).toMatchObject({
      externalId: "387", number: 1, title: "Фильм",
      voiceTracks: [{ name: "AniDUB", playerName: "Kodik", playerUrl: "https://kodikplayer.com/seria/film387" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
