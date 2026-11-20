import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = await readFile(
  new URL("../browser-extension/content.js", import.meta.url),
  "utf8",
);

describe("AnimeGO AniBoom iframe tracking", () => {
  it("uses the parent AnimeGO title and active episode when the iframe video reaches 90%", () => {
    const parentListeners: Record<string, (event: any) => void> = {};
    const frameListeners: Record<string, (event: any) => void> = {};
    const sentEvents: any[] = [];
    let frameWindow: any;
    const parentWindow = {
      addEventListener(type: string, listener: (event: any) => void) {
        parentListeners[type] = listener;
      },
      postMessage(data: unknown) {
        parentListeners.message?.({
          origin: "https://aniboom.one",
          source: frameWindow,
          data,
        });
      },
    };
    frameWindow = {
      parent: parentWindow,
      setInterval() {
        return 1;
      },
      clearInterval() {},
      addEventListener(type: string, listener: (event: any) => void) {
        frameListeners[type] = listener;
      },
      postMessage(data: unknown) {
        frameListeners.message?.({
          origin: "https://animego.me",
          source: parentWindow,
          data,
        });
      },
    };

    let currentEpisode = 7;
    const activeItem = {
      getAttribute(name: string) {
        return name === "data-episode-number" ? String(currentEpisode) : null;
      },
      querySelector() {
        return null;
      },
    };
    const titleElement = {
      textContent: "Агенты четырёх сезонов: Весенний танец",
      getAttribute() {
        return null;
      },
    };
    const iframe = {
      src: "https://aniboom.one/embed/player",
      contentWindow: frameWindow,
    };
    const parentDocument = {
      title: "AnimeGO",
      documentElement: {},
      querySelector(selector: string) {
        if (selector === "h1") return titleElement;
        if (selector === ".player-video-bar__item.active") return activeItem;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === "iframe" ? [iframe] : [];
      },
    };

    const videoListeners: Record<string, () => void> = {};
    const video = {
      dataset: {} as Record<string, string>,
      currentTime: 91,
      duration: 100,
      currentSrc: "https://cdn.example/video.m3u8",
      src: "",
      getBoundingClientRect() {
        return { width: 697, height: 392 };
      },
      addEventListener(type: string, listener: () => void) {
        videoListeners[type] = listener;
      },
    };
    const frameDocument = {
      title: "AniBoom — JAM CLUB",
      documentElement: {},
      querySelector() {
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === "video" ? [video] : [];
      },
    };

    class FakeMutationObserver {
      observe() {}
      disconnect() {}
    }
    class FakeHTMLSelectElement {}

    const common = {
      HTMLSelectElement: FakeHTMLSelectElement,
      MutationObserver: FakeMutationObserver,
      getComputedStyle() {
        return { display: "block", visibility: "visible" };
      },
      chrome: {
        runtime: {
          onMessage: {
            addListener() {},
          },
          sendMessage(message: unknown) {
            sentEvents.push(message);
          },
        },
      },
      crypto: {
        randomUUID: () => "test-event-id",
      },
      Date,
      URL,
    };

    // The iframe initializes first and attaches to the video before AnimeGO's
    // parent metadata is available. The video is already past 90% when metadata arrives.
    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "aniboom.one",
        origin: "https://aniboom.one",
        pathname: "/embed/player",
        href: "https://aniboom.one/embed/player",
      },
      document: frameDocument,
      window: frameWindow,
    });

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "animego.me",
        origin: "https://animego.me",
        pathname: "/anime/example",
        href: "https://animego.me/anime/example",
      },
      document: parentDocument,
      window: parentWindow,
    });

    // The initial metadata arrives while the reused video element is already
    // near the end. Require a real forward playback tick before emitting.
    video.currentTime = 92;
    videoListeners.timeupdate?.();

    let watchEvents = sentEvents.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(watchEvents).toHaveLength(1);
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "MIDAHOSHI_CURRENT_WATCH",
      title: "Агенты четырёх сезонов: Весенний танец",
      episode: 7,
    }));
    expect(watchEvents[0]).toMatchObject({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        service: "animego",
        title: "Агенты четырёх сезонов: Весенний танец",
        episode: 7,
        sourceUrl: "https://animego.me/anime/example",
        currentTimeSeconds: 92,
        durationSeconds: 100,
      },
    });

    // Switching the parent episode must not relabel the old episode's 92%
    // timestamp as a completed watch for episode 8.
    currentEpisode = 8;
    parentWindow.postMessage({ type: "MIDAHOSHI_REQUEST_PARENT_METADATA" });
    watchEvents = sentEvents.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(watchEvents).toHaveLength(1);

    // AniBoom resets its timeline. Only after the new episode genuinely
    // reaches 90% should a second event be emitted.
    video.currentTime = 0;
    videoListeners.timeupdate?.();
    for (let time = 4.5; time <= 90; time += 4.5) {
      video.currentTime = time;
      videoListeners.timeupdate?.();
    }

    watchEvents = sentEvents.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(watchEvents).toHaveLength(2);
    expect(watchEvents[1].event).toMatchObject({
      episode: 8,
      currentTimeSeconds: 90,
      durationSeconds: 100,
    });
  });
});
