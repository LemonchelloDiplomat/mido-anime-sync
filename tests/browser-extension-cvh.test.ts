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

describe("AnimeGO CVH iframe tracking", () => {
  it("forwards AnimeGO metadata from its CVH iframe to the nested player iframe", () => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const forwardedMessages: any[] = [];
    const parentWindow = { postMessage() {} };
    const playerWindow = {
      postMessage(data: unknown, origin: string) {
        forwardedMessages.push({ data, origin });
      },
    };
    const playerFrame = {
      src: "https://player.cdnvideohub.com/s2/v2.43.56/frame/",
      contentWindow: playerWindow,
    };
    const window = {
      parent: parentWindow,
      addEventListener(type: string, listener: (event: any) => void) {
        (listeners[type] ||= []).push(listener);
      },
      setInterval() { return 1; },
      clearInterval() {},
    };
    const document = {
      title: "CVH — JAM CLUB",
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll(selector: string) {
        return selector === "iframe" ? [playerFrame] : [];
      },
    };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "animego.me",
        origin: "https://animego.me",
        pathname: "/cdn-iframe/61443/Jam%20Club/1/7",
        href: "https://animego.me/cdn-iframe/61443/Jam%20Club/1/7",
      },
      document,
      window,
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    });

    for (const listener of listeners.message || []) {
      listener({
        source: parentWindow,
        origin: "https://animego.me",
        data: {
          type: "MIDAHOSHI_PARENT_METADATA",
          metadata: {
            title: "Агенты четырёх сезонов: Весенний танец",
            episode: 7,
            sourceUrl: "https://animego.me/anime/example",
          },
        },
      });
    }

    expect(forwardedMessages).toHaveLength(1);
    expect(forwardedMessages[0]).toMatchObject({
      origin: "https://player.cdnvideohub.com",
      data: {
        type: "MIDAHOSHI_PARENT_METADATA",
        metadata: {
          title: "Агенты четырёх сезонов: Весенний танец",
          episode: 7,
          sourceUrl: "https://animego.me/anime/example",
        },
      },
    });
  });

  it("records a CVH watch event from real playback samples in the nested player frame", () => {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const sentEvents: any[] = [];
    const parentWindow = { postMessage() {} };
    const window = {
      parent: parentWindow,
      addEventListener(type: string, listener: (event: any) => void) {
        (listeners[type] ||= []).push(listener);
      },
      setInterval() { return 1; },
      clearInterval() {},
    };
    const document = { title: "", documentElement: {}, querySelectorAll() { return []; } };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "player.cdnvideohub.com",
        origin: "https://player.cdnvideohub.com",
        pathname: "/s2/v2.43.56/frame/",
        href: "https://player.cdnvideohub.com/s2/v2.43.56/frame/",
      },
      document,
      window,
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message: unknown) { sentEvents.push(message); },
        },
      },
      crypto: { randomUUID: () => "cvh-player-test-event-id" },
    });

    const dispatch = (event: any) => {
      for (const listener of listeners.message || []) listener(event);
    };

    dispatch({
      source: parentWindow,
      origin: "https://animego.me",
      data: {
        type: "MIDAHOSHI_PARENT_METADATA",
        metadata: {
          title: "Агенты четырёх сезонов: Весенний танец",
          episode: 7,
          sourceUrl: "https://animego.me/anime/example",
        },
      },
    });

    const sendSample = (currentTime: number, overrides = {}) => {
      dispatch({
        source: window,
        origin: "https://player.cdnvideohub.com",
        data: {
          type: "MIDAHOSHI_CVH_STATE",
          state: {
            currentTime,
            duration: 1427.712,
            paused: false,
            readyState: 4,
            ...overrides,
          },
        },
      });
    };

    sendSample(1420);
    expect(sentEvents).toHaveLength(0);
    sendSample(1421);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        service: "animego",
        title: "Агенты четырёх сезонов: Весенний танец",
        episode: 7,
        sourceUrl: "https://animego.me/anime/example",
        currentTimeSeconds: 1421,
        durationSeconds: 1427,
        hasVideoElement: true,
        manualOnly: false,
      },
    });

    sendSample(1422);
    expect(sentEvents).toHaveLength(1);
  });

  it("samples the native video from the VK player's internal open shadow root", () => {
    const messages: any[] = [];
    let intervalCallback: (() => void) | undefined;
    const video = {
      currentTime: 166.289,
      duration: 1427.712,
      paused: false,
      readyState: 4,
    };
    const player = {
      _shadowRoot: {
        mode: "open",
        querySelector: (selector: string) => selector === "video" ? video : null,
      },
    };
    const fakeWindow: any = {
      setInterval(callback: () => void) {
        intervalCallback = callback;
        return 1;
      },
      addEventListener() {},
      clearInterval() {},
      postMessage(message: unknown, targetOrigin: string) {
        messages.push({ message, targetOrigin });
      },
    };

    vm.runInNewContext(cvhPageScript, {
      location: {
        hostname: "player.cdnvideohub.com",
        origin: "https://player.cdnvideohub.com",
        pathname: "/s2/v2.43.56/frame/",
      },
      document: {
        querySelector: (selector: string) => selector === "vk-video-player" ? player : null,
      },
      window: fakeWindow,
      Number,
    });

    intervalCallback?.();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toMatchObject({
      targetOrigin: "https://player.cdnvideohub.com",
      message: {
        type: "MIDAHOSHI_CVH_STATE",
        state: {
          currentTime: 166.289,
          duration: 1427.712,
          paused: false,
          readyState: 4,
        },
      },
    });
  });
});
