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

  it("detects the active episode and emits one event after real playback crosses 90%", () => {
    const harness = createAnixartContentHarness();
    const send = (episode: number, currentTime: number, overrides = {}) => harness.dispatch({
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
