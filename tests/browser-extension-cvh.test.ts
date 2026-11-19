import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = await readFile(
  new URL("../browser-extension/content.js", import.meta.url),
  "utf8",
);
const cvhPageScript = await readFile(
  new URL("../browser-extension/cvh-page.js", import.meta.url),
  "utf8",
);

describe("AnimeGO CVH iframe tracking", () => {
  it("uses parent AnimeGO metadata and requires real forward playback at 90%", () => {
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
          origin: "https://animego.me",
          source: frameWindow,
          data,
        });
      },
    };
    frameWindow = {
      parent: parentWindow,
      setInterval() { return 1; },
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
      querySelector() { return null; },
    };
    const titleElement = {
      textContent: "Агенты четырёх сезонов: Весенний танец",
      getAttribute() { return null; },
    };
    const iframe = {
      src: "https://animego.me/cdn-iframe/61443/Jam%20Club/1/7",
      dataset: { providerSlug: "cvh" },
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
    const frameDocument = {
      title: "CVH — JAM CLUB",
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };

    class FakeMutationObserver {
      observe() {}
      disconnect() {}
    }
    class FakeHTMLSelectElement {}

    const common = {
      HTMLSelectElement: FakeHTMLSelectElement,
      MutationObserver: FakeMutationObserver,
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message: unknown) { sentEvents.push(message); },
        },
      },
      crypto: { randomUUID: () => "cvh-test-event-id" },
      Date,
      URL,
    };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "animego.me",
        origin: "https://animego.me",
        pathname: "/cdn-iframe/61443/Jam%20Club/1/7",
        href: "https://animego.me/cdn-iframe/61443/Jam%20Club/1/7",
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

    const sendSample = (currentTime: number, episode = 7) => {
      frameListeners.message?.({
        source: frameWindow,
        origin: "https://animego.me",
        data: {
          type: "MIDAHOSHI_CVH_STATE",
          state: { currentTime, duration: 100, episode },
        },
      });
    };

    sendSample(95);
    expect(sentEvents).toHaveLength(0);
    sendSample(96);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        service: "animego",
        title: "Агенты четырёх сезонов: Весенний танец",
        episode: 7,
        sourceUrl: "https://animego.me/anime/example",
        currentTimeSeconds: 96,
        durationSeconds: 100,
      },
    });

    sendSample(97);
    expect(sentEvents).toHaveLength(1);
  });

  it("samples only numeric playback state from the CVH public API", () => {
    const messages: any[] = [];
    let intervalCallback: (() => void) | undefined;
    const player = {
      api: {
        getCurrentTime: () => 123.5,
        getDuration: () => 1000,
      },
      state: { currentEpisode: { name: 4 } },
      getAttribute: () => "4",
    };
    const fakeWindow = {
      setInterval(callback: () => void) {
        intervalCallback = callback;
        return 1;
      },
      addEventListener() {},
      clearInterval() {},
      postMessage(message: unknown) { messages.push(message); },
    };

    vm.runInNewContext(cvhPageScript, {
      location: {
        hostname: "animego.me",
        pathname: "/cdn-iframe/61443/Jam%20Club/1/4",
        origin: "https://animego.me",
      },
      document: { querySelector: (selector: string) => selector === "#pcvh" ? player : null },
      window: fakeWindow,
      Number,
    });

    intervalCallback?.();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toMatchObject({
      type: "MIDAHOSHI_CVH_STATE",
      state: { currentTime: 123.5, duration: 1000, episode: 4 },
    });
  });
});
