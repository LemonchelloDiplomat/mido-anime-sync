import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = await readFile(
  new URL("../browser-extension/content.js", import.meta.url),
  "utf8",
);
const pageScript = await readFile(
  new URL("../browser-extension/anixart-page.js", import.meta.url),
  "utf8",
);

class FakeMutationObserver {
  observe() {}
  disconnect() {}
}

class FakeHTMLSelectElement {}

function createAnixartContentHarness() {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const sentMessages: any[] = [];
  const runtimeListeners: ((message: any, sender: any, sendResponse: (value: any) => void) => void)[] = [];
  const title = { textContent: "Магическая битва 2", getAttribute() { return null; } };
  const window: any = {
    addEventListener(type: string, listener: (event: any) => void) {
      (listeners[type] ||= []).push(listener);
    },
  };
  const document = {
    title: "Магическая битва 2 | AnixART",
    documentElement: {},
    querySelector(selector: string) {
      if (selector === "h1") return title;
      return null;
    },
    querySelectorAll() { return []; },
  };

  vm.runInNewContext(contentScript, {
    location: {
      hostname: "anixart.site",
      origin: "https://anixart.site",
      pathname: "/7004-magicheskaja-bitva-2.html",
      href: "https://anixart.site/7004-magicheskaja-bitva-2.html",
    },
    document,
    window,
    HTMLSelectElement: FakeHTMLSelectElement,
    MutationObserver: FakeMutationObserver,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener: any) { runtimeListeners.push(listener); },
        },
        sendMessage(message: unknown) { sentMessages.push(message); },
      },
    },
    crypto: { randomUUID: () => "anixart-event-id" },
    URL,
    Date,
  });

  const dispatch = (state: any, origin = "https://anixart.site", source = window) => {
    for (const listener of listeners.message || []) {
      listener({ source, origin, data: { type: "MIDAHOSHI_ANIXART_STATE", state } });
    }
  };

  return { sentMessages, runtimeListeners, window, dispatch };
}

describe("AnixART site playback integration", () => {
  it("samples only safe playback metadata from the page player state", () => {
    const messages: any[] = [];
    let intervalCallback: (() => void) | undefined;
    const state = {
      currentSeason: { name: 2 },
      currentEpisode: { name: 5 },
      currentVoice: { name: "AniBoom" },
      currentVideo: {
        season: 2,
        episode: 5,
        voiceStudio: "AniBoom",
        cvhId: "not-forwarded",
        vkId: "not-forwarded",
      },
      position: 292.5,
      duration: 1435.1,
      playing: true,
    };
    const player = { state };
    const window: any = {
      postMessage(message: unknown, targetOrigin: string) {
        messages.push({ message, targetOrigin });
      },
      setInterval(callback: () => void) {
        intervalCallback = callback;
        return 1;
      },
      addEventListener() {},
      clearInterval() {},
    };

    vm.runInNewContext(pageScript, {
      location: { hostname: "anixart.site", origin: "https://anixart.site" },
      document: {
        querySelector(selector: string) {
          return selector === "video-player" ? player : null;
        },
      },
      window,
      Number,
    });

    intervalCallback?.();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      targetOrigin: "https://anixart.site",
      message: {
        type: "MIDAHOSHI_ANIXART_STATE",
        state: {
          season: 2,
          episode: 5,
          voice: "AniBoom",
          currentTime: 292.5,
          duration: 1435.1,
          playing: true,
        },
      },
    });
    expect(JSON.stringify(messages)).not.toContain("not-forwarded");
  });

  it("publishes a sanitized season, episode, and voice catalog without player identifiers", () => {
    const messages: any[] = [];
    const voiceVideo = {
      cvhId: "private-cvh-id",
      vkId: "private-vk-id",
      voiceStudio: "AniBoom",
      voiceType: "Дубляж",
      season: 2,
      episode: 1,
    };
    const state = {
      seasons: {
        2: {
          name: 2,
          episodes: {
            1: {
              name: 1,
              visibleName: "1",
              voices: {
                AniBoom: { name: "AniBoom", videos: [voiceVideo] },
                "Субтитры": { name: "Субтитры", videos: [] },
                "Субтитры (дубликат)": { name: "Субтитры", videos: [] },
              },
            },
          },
        },
      },
      currentVideo: { season: 2, episode: 1, voiceStudio: "AniBoom" },
      position: 12,
      duration: 100,
      playing: true,
    };
    const window: any = {
      postMessage(message: unknown) { messages.push(message); },
      setInterval() { return 1; },
      addEventListener() {},
      clearInterval() {},
    };

    vm.runInNewContext(pageScript, {
      location: { hostname: "anixart.site", origin: "https://anixart.site", pathname: "/7004-magicheskaja-bitva-2.html" },
      document: {
        title: "Магическая битва 2 | AnixART",
        querySelector(selector: string) {
          if (selector === "video-player") return { state };
          if (selector === "h1") return { textContent: "Магическая битва 2" };
          return null;
        },
      },
      window,
      Number,
      Date,
    });

    const catalogMessage = messages.find((entry) => entry.type === "MIDAHOSHI_ANIXART_CATALOG");
    expect(catalogMessage?.catalog).toMatchObject({
      slug: "7004-magicheskaja-bitva-2.html",
      title: "Магическая битва 2",
      seasons: [{
        number: 2,
        episodes: [{
          number: 1,
          voices: [
            { name: "AniBoom", type: "Дубляж" },
            { name: "Студия не указана", type: "Субтитры" },
          ],
        }],
      }],
      current: { season: 2, episode: 1, voice: "AniBoom" },
    });
    expect(JSON.stringify(catalogMessage)).not.toContain("private-cvh-id");
    expect(JSON.stringify(catalogMessage)).not.toContain("private-vk-id");
  });

  it("publishes the season catalog before a current video has been selected", () => {
    const messages: any[] = [];
    const state = {
      seasons: {
        1: {
          name: 1,
          episodes: {
            1: { name: 1, visibleName: "1", voices: { AniBoom: { name: "AniBoom", videos: [] } } },
            2: { name: 2, visibleName: "2", voices: { AniBoom: { name: "AniBoom", videos: [] } } },
          },
        },
      },
      currentVideo: null,
    };
    let intervalCallback: (() => void) | undefined;
    const window: any = {
      postMessage(message: unknown) { messages.push(message); },
      setInterval(callback: () => void) { intervalCallback = callback; return 1; },
      addEventListener() {},
      clearInterval() {},
    };

    vm.runInNewContext(pageScript, {
      location: { hostname: "anixart.site", origin: "https://anixart.site", pathname: "/7360-put-naruto.html" },
      document: {
        title: "Путь Наруто | AnixART",
        querySelector(selector: string) {
          if (selector === "video-player") return { state };
          if (selector === "h1") return { textContent: "Путь Наруто" };
          return null;
        },
      },
      window,
      Number,
      Date,
    });

    intervalCallback?.();
    const catalogMessage = messages.find((entry) => entry.type === "MIDAHOSHI_ANIXART_CATALOG");
    expect(catalogMessage?.catalog).toMatchObject({
      slug: "7360-put-naruto.html",
      title: "Путь Наруто",
      seasons: [{
        number: 1,
        episodes: [{ number: 1 }, { number: 2 }],
      }],
      current: { season: null, episode: null, voice: null },
    });
    expect(messages.some((entry) => entry.type === "MIDAHOSHI_ANIXART_STATE")).toBe(false);
  });

  it("detects the active episode and emits one event after real playback crosses 90%", () => {
    const harness = createAnixartContentHarness();
    const send = (episode: number, currentTime: number, overrides: Record<string, unknown> = {}) => harness.dispatch({
      season: 2,
      episode,
      voice: "AniBoom",
      currentTime,
      duration: 100,
      playing: true,
      ...overrides,
    });

    send(5, 89);
    send(5, 89.5, { voice: "Force Media" });
    send(5, 90);
    expect(harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(1);
    expect(harness.sentMessages).toContainEqual(expect.objectContaining({
      type: "MIDAHOSHI_CURRENT_WATCH",
      title: "Магическая битва 2",
      episode: 5,
    }));
    const event = harness.sentMessages.find(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(event.event).toMatchObject({
      service: "anixart",
      title: "Магическая битва 2",
      episode: 5,
      season: 2,
      voice: "AniBoom",
      sourceUrl: "https://anixart.site/7004-magicheskaja-bitva-2.html",
      currentTimeSeconds: 90,
      durationSeconds: 100,
    });

    send(5, 95);
    expect(harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(1);

    // A new episode must reset the timeline before progress can be attributed to it.
    send(6, 95);
    send(6, 0);
    send(6, 89);
    send(6, 90);
    const events = harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({ episode: 6, season: 2, voice: "AniBoom" });
  });

  it("waits until floored seconds also satisfy the 90% threshold", () => {
    const harness = createAnixartContentHarness();
    const send = (currentTime: number) => harness.dispatch({
      season: 7,
      episode: 7,
      voice: "AnimeVost",
      currentTime,
      duration: 1505.2472108843504,
      playing: true,
    });

    // The raw ratio is already above 90%, but flooring both values would
    // produce 1354 / 1505, which the background correctly rejects.
    send(1353.8);
    send(1354.8);
    expect(harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(0);

    // The next real playback sample crosses 90% using the exact integer
    // values that are forwarded to the background.
    send(1355.8);
    const events = harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({
      episode: 7,
      season: 7,
      voice: "AnimeVost",
      currentTimeSeconds: 1355,
      durationSeconds: 1505,
    });
  });

  it("ignores messages that do not come from the page itself and same origin", () => {
    const harness = createAnixartContentHarness();
    const sample = {
      season: 2, episode: 5, voice: "AniBoom",
      currentTime: 99, duration: 100, playing: true,
    };
    harness.dispatch(sample, "https://evil.example");
    harness.dispatch(sample, "https://anixart.site", {});
    expect(harness.sentMessages.filter(message => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT")).toHaveLength(0);
  });

  it("registers the AnixART page-world sampler only for the intended website", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("../browser-extension/manifest.json", import.meta.url),
      "utf8",
    ));
    const matches = manifest.content_scripts.flatMap((script: any) => script.matches);
    expect(matches).toEqual(expect.arrayContaining([
      "*://anixart.site/*",
      "*://*.anixart.site/*",
      "https://anixart.site/*",
    ]));
    const pageWorld = manifest.content_scripts.find((script: any) => script.js.includes("anixart-page.js"));
    expect(pageWorld.world).toBe("MAIN");
  });
});
