import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAnimeGoRequest,
  parseAnimeGoDetail,
  parseAnimeGoPlayer,
  parseAnimeGoSearch,
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
<div class="grid ani-list">
  <div class="ani-grid__item">
    <a class="ani-grid__item-picture" href="/anime/sample-title-1234"><img class="image__img" src="/uploads/sample.jpg" alt="Sample Anime"></a>
    <div class="ani-grid__item-title"><a href="/anime/sample-title-1234">Sample Anime</a></div>
  </div>
</div>`;

const detailHtml = `
<link rel="canonical" href="https://animego.org/anime/sample-title-1234">
<meta property="og:image" content="https://animego.org/poster.jpg">
<meta name="description" content="A sample synopsis">
<h1>Sample Anime</h1>
<script type="application/ld+json">{"datePublished":"2024-01-01","alternateName":"Sample JP","genre":["Action","Drama"],"numberOfEpisodes":12,"aggregateRating":{"ratingValue":8.2}}</script>`;

afterEach(() => vi.unstubAllGlobals());

describe("AnimeGO public catalog adapter", () => {
  it("parses public search cards and canonical page slugs", () => {
    const items = parseAnimeGoSearch(searchHtml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: "animego",
      externalId: "sample-title-1234",
      title: "Sample Anime",
      url: "https://animego.org/anime/sample-title-1234",
      posterUrl: "https://animego.org/uploads/sample.jpg",
    });
  });

  it("parses public title metadata and exact AnimeGO identity", () => {
    const title = parseAnimeGoDetail(detailHtml, "https://animego.org/anime/sample-title-1234");
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

  it("parses episode and dubbing labels without extracting player URLs", () => {
    const parsed = parseAnimeGoPlayer({
      data: {
        content: `
          <div class="player-video-bar__item" data-episode-number="1" data-episode-title="First" data-episode="555"></div>
          <div class="player-video-bar__item" data-episode-number="2" data-episode-title="Second" data-episode="556"></div>
          <button data-translation="22"><span>Studio Example</span></button>
          <button data-player="https://player.example/embed?token=secret">Play</button>
        `,
      },
    }, "https://animego.org/anime/sample-title-1234");
    expect(parsed.episodes.map((episode) => episode.number)).toEqual([1, 2]);
    expect(parsed.voices).toEqual([{ externalId: "22", name: "Studio Example" }]);
    expect(JSON.stringify(parsed)).not.toContain("player.example");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("proxies catalog search through the local server and declares account sync unsupported", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() { return searchHtml; },
    }));
    vi.stubGlobal("fetch", fetcher);
    const deps = { sendJson(res: ReturnType<typeof responseCapture>, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); } };
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
});
