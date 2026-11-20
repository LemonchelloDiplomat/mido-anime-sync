import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAnixArtRequest,
  parseAnixArtDetail,
  parseAnixArtSearch,
  parseAnixArtPlayerPlaylist,
  selectAnixArtVideoSource,
} from "../server/anixart-routes.mjs";

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
<div class="shortstory">
  <a href="https://anixart.site/7004-magicheskaja-bitva-2.html"><img src="/uploads/jjk2.jpg" alt="Магическая битва 2"></a>
  <h2><a href="/7004-magicheskaja-bitva-2.html">Магическая битва 2</a></h2>
</div>`;

const detailHtml = `
<link rel="canonical" href="https://anixart.site/7004-magicheskaja-bitva-2.html">
<meta property="og:image" content="https://anixart.site/uploads/jjk2.jpg">
<meta name="description" content="История о магах">
<h1>Магическая битва 2</h1>
<ul>
  <li>Год: 2023</li>
  <li>Жанр: <a>Экшен</a>, <a>Фэнтези</a></li>
  <li>Озвучка: <a>AniLibria.TV</a>, <a>OnWave</a></li>
</ul>
<div>23 из 23</div>
<video-player id="myPlayer" data-title-id="51009" data-publisher-id="1103"></video-player>`;

afterEach(() => vi.unstubAllGlobals());

describe("AnixART public website catalog adapter", () => {
  it("parses title search results and keeps the page slug", () => {
    const items = parseAnixArtSearch(searchHtml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: "anixart",
      externalId: "7004-magicheskaja-bitva-2.html",
      title: "Магическая битва 2",
      url: "https://anixart.site/7004-magicheskaja-bitva-2.html",
    });
  });

  it("removes AnixART ratings and card metadata from search titles", () => {
    const html = `
      <div class="shortstory">
        <a href="/7360-put-naruto.html">8.5 8.46 Путь Наруто 2022, экшен, фэнтези,</a>
        <a href="/7361-boruto.html">5.8 6.06 Боруто: Новое поколение Наруто 2017, экшен,</a>
        <a href="/7362-naruto.html">9.5 7.98 Наруто 2002, экшен,</a>
        <a href="/7363-naruto-movie.html">10 6.54 Наруто: Найти тёмно-красный четырёхлистный клевер! 2003, сёнен,</a>
      </div>`;
    expect(parseAnixArtSearch(html).map((item) => item.title)).toEqual([
      "Путь Наруто",
      "Боруто: Новое поколение Наруто",
      "Наруто",
      "Наруто: Найти тёмно-красный четырёхлистный клевер!",
    ]);
  });

  it("extracts AnixART posters from lazy attributes and CSS background wrappers", () => {
    const html = `
      <div class="shortstory">
        <a href="/8001-lazy-poster.html"><div class="poster"><img data-original="/images/lazy.jpg" src="/images/placeholder.jpg"></div><span>Lazy poster</span></a>
      </div>
      <div class="shortstory">
        <a href="/8002-background-poster.html"><div class="poster" style="background-image:url('/images/background.jpg')"></div><span>Background poster</span></a>
      </div>`;
    expect(parseAnixArtSearch(html).map((item) => item.posterUrl)).toEqual([
      "https://anixart.site/images/lazy.jpg",
      "https://anixart.site/images/background.jpg",
    ]);
  });

  it("parses public title metadata, dubbings and the player identifiers only", () => {
    const title = parseAnixArtDetail(detailHtml, "https://anixart.site/7004-magicheskaja-bitva-2.html");
    expect(title).toMatchObject({
      provider: "anixart",
      externalId: "7004-magicheskaja-bitva-2.html",
      title: "Магическая битва 2",
      year: 2023,
      episodeCount: null,
      sourceMetadata: { playerTitleId: "51009", publisherId: "1103" },
    });
    expect(title.voices.map((voice) => voice.name)).toEqual(["AniLibria.TV", "OnWave"]);
    expect(title.identity.externalIds.anixart).toBe("7004");
    expect(title.identity.episodes).toBeNull();
    expect(title.seasons).toEqual([]);
    expect(JSON.stringify(title)).not.toContain("iframe");
    expect(JSON.stringify(title)).not.toContain("token");
  });

  it("finds CVH player identifiers on non-video-player wrappers used by some title types", () => {
    const html = detailHtml.replace(
      '<video-player id="myPlayer" data-title-id="51009" data-publisher-id="1103"></video-player>',
      '<div id="cdn-player" data-title-id="7360" data-publisher-id="1103" data-aggregator="mali"></div>',
    );
    expect(parseAnixArtDetail(html, "https://anixart.site/7360-put-naruto.html").sourceMetadata).toMatchObject({
      playerTitleId: "7360", publisherId: "1103", aggregator: "mali",
    });
  });

  it("maps a single CVH video row without episode metadata to a synthetic film episode", () => {
    const parsed = parseAnixArtPlayerPlaylist({ items: [
      { voiceStudio: "AniLane", voiceType: "Озвучка", vkId: "7360001" },
    ] }, "https://anixart.site/7360-put-naruto.html");
    expect(parsed).toMatchObject({
      episodeCount: 1,
      seasons: [{ number: 1, episodes: [{ number: 1, title: "Фильм", voiceTracks: [
        { name: "AniLane", playerUrl: "/api/anixart/stream/7360001" },
      ] }] }],
    });
  });

  it("maps the public CVH playlist into seasons, episodes, and voice variants", () => {
    const parsed = parseAnixArtPlayerPlaylist({
      items: [
        { season: 2, episode: 1, name: "Первая серия", voiceStudio: "AniBoom", voiceType: "Дубляж", vkId: "12345" },
        { season: 2, episode: 1, voiceStudio: "Субтитры", voiceType: "Субтитры", vkId: "private-id-2" },
        { season: 1, episode: 3, voiceStudio: "AniLibria", voiceType: "Многоголосый", vkId: "private-id-3" },
      ],
    }, "https://anixart.site/7004-magicheskaja-bitva-2.html");
    expect(parsed).toMatchObject({
      episodeCount: 2,
      seasons: [
        { number: 1, episodes: [{ number: 3, voiceTracks: [{ name: "AniLibria", playerName: "Многоголосый" }] }] },
        { number: 2, episodes: [{ number: 1, title: "Первая серия", voiceTracks: [
          { name: "AniBoom", playerName: "Дубляж", playerUrl: "/api/anixart/stream/12345" },
          { name: "Субтитры", playerName: "Субтитры" },
        ] }] },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("private-id");
  });

  it("selects the highest available MP4 source from CVH video metadata", () => {
    expect(selectAnixArtVideoSource({
      sources: {
        hlsUrl: "https://vd576.okcdn.ru/master.m3u8",
        mpegHighUrl: "https://vd576.okcdn.ru/720.mp4",
        mpegFullHdUrl: "https://vd576.okcdn.ru/1080.mp4",
      },
    })).toBe("https://vd576.okcdn.ru/1080.mp4");
    expect(selectAnixArtVideoSource({ sources: { mpegHighUrl: "http://vd576.okcdn.ru/insecure.mp4" } })).toBeNull();
    expect(selectAnixArtVideoSource({ sources: { mpegHighUrl: "https://evil.example/video.mp4" } })).toBeNull();
  });

  it("proxies CVH MP4 playback and forwards byte-range requests", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = String(input);
      if (target.includes("/video/12345")) {
        return new Response(JSON.stringify({ sources: { mpegFullHdUrl: "https://vd576.okcdn.ru/video.mp4" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("video-bytes", {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-10/11", "Content-Length": "11" },
      });
    });
    const chunks: Buffer[] = [];
    const response = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    }) as Writable & { status?: number; headers?: Record<string, string>; writeHead(status: number, headers?: Record<string, string>): void };
    response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; };
    const finished = new Promise<void>((resolve) => response.on("finish", resolve));
    await handleAnixArtRequest(
      { method: "GET", headers: { range: "bytes=0-10" } },
      response,
      new URL("http://127.0.0.1/api/anixart/stream/12345"),
      {
        fetch: fetcher,
        sendJson(res: any, status: number, body: unknown) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); },
      },
    );
    await finished;
    expect(response.status).toBe(206);
    expect(response.headers).toMatchObject({ "Content-Type": "video/mp4", "content-range": "bytes 0-10/11" });
    expect(Buffer.concat(chunks).toString()).toBe("video-bytes");
    expect(fetcher).toHaveBeenCalledWith(
      "https://vd576.okcdn.ru/video.mp4",
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=0-10", Referer: "https://player.cdnvideohub.com/" }) }),
    );
  });

  it("loads the AnixART CVH playlist directly from the local server route", async () => {
    const playlist = { items: [
      { season: 1, episode: 1, voiceStudio: "AniBoom", voiceType: "Дубляж", vkId: "not-returned" },
      { season: 1, episode: 2, voiceStudio: "AniBoom", voiceType: "Дубляж", vkId: "not-returned-2" },
    ] };
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const target = String(input);
      if (target.includes("plapi.cdnvideohub.com")) {
        return new Response(JSON.stringify(playlist), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(detailHtml, { status: 200 });
    });
    const deps = {
      fetch: fetcher,
      sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) {
        res.writeHead(status);
        res.end(JSON.stringify(body));
      },
    };
    const response = responseCapture();
    await handleAnixArtRequest(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1/api/anixart/anime/7004-magicheskaja-bitva-2.html"),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      episodeCount: 2,
      seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("pub=1103");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("aggr=mali");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("id=51009");
    expect(JSON.stringify(response.json())).not.toContain("not-returned");
  });

  it("loads a one-row AnixART film playlist through the title details route", async () => {
    const filmHtml = detailHtml
      .replace('https://anixart.site/7004-magicheskaja-bitva-2.html', 'https://anixart.site/7360-put-naruto.html')
      .replace('Магическая битва 2', 'Путь Наруто')
      .replace('<video-player id="myPlayer" data-title-id="51009" data-publisher-id="1103"></video-player>', '<div id="cdn-player" data-title-id="7360" data-publisher-id="1103"></div>');
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const target = String(input);
      if (target.includes("plapi.cdnvideohub.com")) {
        return new Response(JSON.stringify({ items: [
          { voiceStudio: "AniLane", voiceType: "Озвучка", vkId: "7360001" },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(filmHtml, { status: 200 });
    });
    const response = responseCapture();
    await handleAnixArtRequest(
      { method: "GET" }, response,
      new URL("http://127.0.0.1/api/anixart/anime/7360-put-naruto.html"),
      { fetch: fetcher, sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } },
    );
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      title: "Путь Наруто",
      episodeCount: 1,
      seasons: [{ number: 1, episodes: [{ title: "Фильм", voiceTracks: [
        { name: "AniLane", playerUrl: "/api/anixart/stream/7360001" },
      ] }] }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("proxies public site search and explicitly reports unsupported account capabilities", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      async text() { return searchHtml; },
    }));
    vi.stubGlobal("fetch", fetcher);
    const deps = { sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
    const searchResponse = responseCapture();
    await handleAnixArtRequest(
      { method: "GET" },
      searchResponse,
      new URL("http://127.0.0.1/api/anixart/search?q=магическая"),
      deps,
    );
    expect(searchResponse.status).toBe(200);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("do=search");
    expect(searchResponse.json().items[0].title).toBe("Магическая битва 2");

    const statusResponse = responseCapture();
    await handleAnixArtRequest(
      { method: "GET" },
      statusResponse,
      new URL("http://127.0.0.1/api/anixart/status"),
      deps,
    );
    expect(statusResponse.json()).toMatchObject({
      catalogSearch: true,
      fullSeasonEpisodeManifest: true,
      playerCatalogSource: "server-cvh-api",
      playback: "server-cvh-mp4-proxy",
      accountConnection: false,
      listImport: false,
      watchProgressRead: "browser-extension",
    });
  });
});
