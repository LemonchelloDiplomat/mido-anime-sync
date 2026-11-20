import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAnixArtRequest,
  parseAnixArtDetail,
  parseAnixArtSearch,
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

  it("parses public title metadata, dubbings and the player identifiers only", () => {
    const title = parseAnixArtDetail(detailHtml, "https://anixart.site/7004-magicheskaja-bitva-2.html");
    expect(title).toMatchObject({
      provider: "anixart",
      externalId: "7004-magicheskaja-bitva-2.html",
      title: "Магическая битва 2",
      year: 2023,
      episodeCount: 23,
      sourceMetadata: { playerTitleId: "51009", publisherId: "1103" },
    });
    expect(title.voices.map((voice) => voice.name)).toEqual(["AniLibria.TV", "OnWave"]);
    expect(title.identity.externalIds.anixart).toBe("7004");
    expect(title.seasons).toEqual([]);
    expect(JSON.stringify(title)).not.toContain("iframe");
    expect(JSON.stringify(title)).not.toContain("token");
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
      fullSeasonEpisodeManifest: false,
      accountConnection: false,
      listImport: false,
      watchProgressRead: "browser-extension",
    });
  });
});
