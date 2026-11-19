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

    const activeItem = {
      getAttribute(name: string) {
        return name === "data-episode-number" ? "7" : null;
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

    videoListeners.timeupdate?.();

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        service: "animego",
        title: "Агенты четырёх сезонов: Весенний танец",
        episode: 7,
        sourceUrl: "https://animego.me/anime/example",
        currentTimeSeconds: 91,
        durationSeconds: 100,
      },
    });
  });
});
