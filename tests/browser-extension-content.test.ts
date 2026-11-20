import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = await readFile(
  new URL("../browser-extension/content.js", import.meta.url),
  "utf8",
);

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (value: unknown) => void,
) => unknown;

function detectAnimeGoEpisode(activeEpisodeNumber: string | null, activeButtonLabel = "") {
  const listenerHolder: { current: MessageListener | null } = { current: null };

  const activeItem = activeEpisodeNumber === null
    ? null
    : {
        getAttribute(name: string) {
          return name === "data-episode-number" ? activeEpisodeNumber : null;
        },
        querySelector(selector: string) {
          if (selector !== "button.player-video-bar__number" || !activeButtonLabel) return null;
          return {
            getAttribute(name: string) {
              return name === "aria-label" ? activeButtonLabel : null;
            },
            textContent: "",
          };
        },
      };

  const titleElement = {
    textContent: "Агенты четырёх сезонов: Весенний танец",
    getAttribute() {
      return null;
    },
  };

  const documentMock = {
    title: "AnimeGO",
    documentElement: {},
    querySelector(selector: string) {
      if (selector === ".player-video-bar__item.active") return activeItem;
      if (selector === "h1") return titleElement;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  class FakeHTMLSelectElement {}

  const context = {
    location: {
      hostname: "animego.me",
      origin: "https://animego.me",
      pathname: "/anime/example-3296",
    },
    document: documentMock,
    HTMLSelectElement: FakeHTMLSelectElement,
    MutationObserver: FakeMutationObserver,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener: MessageListener) {
            listenerHolder.current = listener;
          },
        },
      },
    },
    window: {
      addEventListener() {},
    },
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
  };

  vm.runInNewContext(contentScript, context);

  let detected: unknown;
  const messageListener = listenerHolder.current;
  if (!messageListener) {
    throw new Error("Content script did not register its message listener");
  }

  messageListener(
    { type: "MIDAHOSHI_DETECT_WATCH_EVENT" },
    {},
    (value: unknown) => {
      detected = value;
    },
  );

  return detected as { episode: number | null; title: string; service: string };
}

describe("AnimeGO browser episode detection", () => {
  it("reads the selected episode from the active episode item's data attribute", () => {
    expect(detectAnimeGoEpisode("2")).toMatchObject({
      service: "animego",
      episode: 2,
      title: "Агенты четырёх сезонов: Весенний танец",
    });
  });

  it("uses the active button label when the active item's number is unavailable", () => {
    expect(detectAnimeGoEpisode("", "Выбрать серию 3").episode).toBe(3);
  });

  it("does not guess an episode when no active episode item exists", () => {
    expect(detectAnimeGoEpisode(null).episode).toBeNull();
  });

  it("detects YummyAnime title, episode, and 90-percent playback progress", () => {
    const listeners: Record<string, () => void> = {};
    const sentMessages: any[] = [];
    const video = {
      currentTime: 88,
      duration: 100,
      currentSrc: "https://cdn.example/yummy-episode.m3u8",
      src: "",
      paused: false,
      getBoundingClientRect() { return { width: 640, height: 360 }; },
      addEventListener(type: string, listener: () => void) {
        listeners[type] = listener;
      },
    };
    const titleElement = { textContent: "Санка Рэа", getAttribute() { return null; } };
    const episodeElement = { textContent: "Серия 4", getAttribute() { return null; } };

    class FakeMutationObserver {
      observe() {}
      disconnect() {}
    }
    class FakeHTMLSelectElement {}

    vm.runInNewContext(contentScript, {
      location: {
        hostname: "yummyani.me",
        origin: "https://yummyani.me",
        pathname: "/catalog/sanka-reya/episode-4",
        href: "https://yummyani.me/catalog/sanka-reya/episode-4",
      },
      document: {
        title: "Санка Рэа",
        documentElement: {},
        querySelector(selector: string) {
          if (selector === "h1") return titleElement;
          if (selector === ".watch__episode") return episodeElement;
          return null;
        },
        querySelectorAll(selector: string) {
          return selector === "video" ? [video] : [];
        },
      },
      HTMLSelectElement: FakeHTMLSelectElement,
      MutationObserver: FakeMutationObserver,
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message: unknown) { sentMessages.push(message); },
        },
      },
      window: { addEventListener() {} },
      crypto: { randomUUID: () => "yummy-test-event-id" },
      URL,
      Date,
    });

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: "MIDAHOSHI_CURRENT_WATCH",
      title: "Санка Рэа",
      episode: 4,
    }));

    video.currentTime = 90;
    listeners.timeupdate?.();
    const events = sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      service: "yummyanime",
      title: "Санка Рэа",
      episode: 4,
      sourceUrl: "https://yummyani.me/catalog/sanka-reya/episode-4",
      currentTimeSeconds: 90,
      durationSeconds: 100,
    });

    video.currentTime = 95;
    listeners.timeupdate?.();
    expect(sentMessages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(1);
  });

});
