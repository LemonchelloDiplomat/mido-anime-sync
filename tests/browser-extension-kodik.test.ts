import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = await readFile(
  new URL("../browser-extension/content.js", import.meta.url),
  "utf8",
);

class FakeMutationObserver {
  observe() {}
  disconnect() {}
}

class FakeHTMLSelectElement {}

const common = {
  MutationObserver: FakeMutationObserver,
  HTMLSelectElement: FakeHTMLSelectElement,
  URL,
  Date,
};

describe("Kodik iframe tracking", () => {
  it("forwards AnimeGO title and active episode to its Kodik iframe", () => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const forwarded: any[] = [];
    const playerWindow = { postMessage(data: unknown, origin: string) {
      forwarded.push({ data, origin });
    }};
    const iframe = {
      src: "https://kodikplayer.com/seria/123/hash/720p",
      contentWindow: playerWindow,
    };
    const activeEpisode = {
      getAttribute(name: string) {
        return name === "data-episode-number" ? "7" : null;
      },
      querySelector() { return null; },
    };
    const titleElement = {
      textContent: "Агенты четырёх сезонов: Весенний танец",
      getAttribute() { return null; },
    };
    const document = {
      title: "AnimeGO",
      documentElement: {},
      querySelector(selector: string) {
        if (selector === "h1") return titleElement;
        if (selector === ".player-video-bar__item.active") return activeEpisode;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === "iframe" ? [iframe] : [];
      },
    };
    const window = {
      addEventListener(type: string, listener: (event: any) => void) {
        (listeners[type] ||= []).push(listener);
      },
    };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "animego.me",
        origin: "https://animego.me",
        pathname: "/anime/example",
        href: "https://animego.me/anime/example",
      },
      document,
      window,
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      origin: "https://kodikplayer.com",
      data: {
        type: "MIDAHOSHI_PARENT_METADATA",
        metadata: {
          title: "Агенты четырёх сезонов: Весенний танец",
          episode: 7,
          service: "animego",
          sourceUrl: "https://animego.me/anime/example",
        },
      },
    });
  });

  it("tracks only real forward playback at 90% and resets safely when the episode changes", () => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const sentMessages: any[] = [];
    const parentWindow = { postMessage() {} };
    const videoListeners: Record<string, () => void> = {};
    const video = {
      currentTime: 80,
      duration: 100,
      paused: false,
      currentSrc: "https://cdn.example/video.m3u8",
      src: "",
      getBoundingClientRect() { return { width: 640, height: 360 }; },
      addEventListener(type: string, listener: () => void) {
        videoListeners[type] = listener;
      },
    };
    const document = {
      title: "Kodik Player",
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll(selector: string) {
        return selector === "video" ? [video] : [];
      },
    };
    const window = {
      parent: parentWindow,
      addEventListener(type: string, listener: (event: any) => void) {
        (listeners[type] ||= []).push(listener);
      },
      setInterval() { return 1; },
      clearInterval() {},
    };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "kodikplayer.com",
        origin: "https://kodikplayer.com",
        pathname: "/seria/123/hash/720p",
        href: "https://kodikplayer.com/seria/123/hash/720p",
      },
      document,
      window,
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message: unknown) { sentMessages.push(message); },
        },
      },
      crypto: { randomUUID: () => "kodik-test-event" },
    });

    const dispatch = (episode: number) => {
      for (const listener of listeners.message || []) {
        listener({
          source: parentWindow,
          origin: "https://animego.me",
          data: {
            type: "MIDAHOSHI_PARENT_METADATA",
            metadata: {
              title: "Агенты четырёх сезонов: Весенний танец",
              episode,
              service: "animego",
              sourceUrl: "https://animego.me/anime/example",
            },
          },
        });
      }
    };
    const tick = (time: number) => {
      video.currentTime = time;
      videoListeners.timeupdate?.();
    };

    dispatch(7);
    expect(sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(0);

    tick(89);
    expect(sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(0);
    tick(90);
    let events = sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      service: "animego",
      title: "Агенты четырёх сезонов: Весенний танец",
      episode: 7,
      currentTimeSeconds: 90,
      durationSeconds: 100,
      manualOnly: false,
    });

    // New episode metadata must not reuse the previous episode's near-end time.
    dispatch(8);
    tick(91);
    tick(92);
    expect(sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(1);

    // Wait for the player timeline to reset, then require fresh forward playback.
    tick(0);
    tick(1);
    tick(89);
    tick(90);
    events = sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({
      episode: 8,
      currentTimeSeconds: 90,
      durationSeconds: 100,
    });
  });
});
