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

function runPageDetection(hostname: string) {
  const listeners: Record<string, (message: any, sender: any, respond: (value: any) => void) => void> = {};
  let currentEpisode = 7;
  const title = {
    textContent: "О моём перерождении в меч 2",
    getAttribute() { return null; },
  };
  const selectedEpisode = {
    get textContent() { return String(currentEpisode); },
  };
  const selectedTab = { textContent: "Просмотр" };
  const document = {
    title: "YummyAnime",
    documentElement: {},
    querySelector(selector: string) {
      if (selector === "h1") return title;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-selected="1"]') return [selectedTab, selectedEpisode];
      return [];
    },
  };
  const window = {
    addEventListener() {},
  };

  vm.runInNewContext(contentScript, {
    ...common,
    location: {
      hostname,
      origin: `https://${hostname}`,
      pathname: "/catalog/item/example",
      href: `https://${hostname}/catalog/item/example`,
    },
    document,
    window,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener: typeof listeners.message) {
            listeners.message = listener;
          },
        },
        sendMessage() {},
      },
    },
  });

  let detected: any;
  listeners.message?.(
    { type: "MIDAHOSHI_DETECT_WATCH_EVENT" },
    {},
    (value) => { detected = value; },
  );
  return detected;
}

describe("YummyAnime browser tracking", () => {
  it.each(["ru.yummyani.me", "old.yummyani.me"])(
    "detects the title and numeric active episode on %s",
    (hostname) => {
      const detected = runPageDetection(hostname);
      expect(detected).toMatchObject({
        service: "yummyanime",
        title: "О моём перерождении в меч 2",
        episode: 7,
        sourceUrl: `https://${hostname}/catalog/item/example`,
      });
    },
  );

  it("forwards YummyAnime metadata to embedded Kodik and CVH players", () => {
    const forwarded: any[] = [];
    const kodikWindow = { postMessage(data: unknown, origin: string) {
      forwarded.push({ player: "kodik", data, origin });
    }};
    const cvhWindow = { postMessage(data: unknown, origin: string) {
      forwarded.push({ player: "cvh", data, origin });
    }};
    const frames = [
      { src: "https://kodikplayer.com/seria/123/hash/720p", contentWindow: kodikWindow },
      { src: "https://player.cdnvideohub.com/s2/v2.43.56/frame/", contentWindow: cvhWindow },
    ];
    const title = {
      textContent: "О моём перерождении в меч 2",
      getAttribute() { return null; },
    };
    const selectedEpisode = { textContent: "7" };
    const document = {
      title: "YummyAnime",
      documentElement: {},
      querySelector(selector: string) {
        return selector === "h1" ? title : null;
      },
      querySelectorAll(selector: string) {
        if (selector === '[data-selected="1"]') return [selectedEpisode];
        if (selector === "iframe") return frames;
        return [];
      },
    };
    const window = { addEventListener() {} };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "ru.yummyani.me",
        origin: "https://ru.yummyani.me",
        pathname: "/catalog/item/example",
        href: "https://ru.yummyani.me/catalog/item/example",
      },
      document,
      window,
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    });

    expect(forwarded).toHaveLength(2);
    expect(forwarded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        player: "kodik",
        origin: "https://kodikplayer.com",
        data: {
          type: "MIDAHOSHI_PARENT_METADATA",
          metadata: {
            title: "О моём перерождении в меч 2",
            episode: 7,
            sourceUrl: "https://ru.yummyani.me/catalog/item/example",
            service: "yummyanime",
          },
        },
      }),
      expect.objectContaining({
        player: "cvh",
        origin: "https://player.cdnvideohub.com",
        data: {
          type: "MIDAHOSHI_PARENT_METADATA",
          metadata: {
            title: "О моём перерождении в меч 2",
            episode: 7,
            sourceUrl: "https://ru.yummyani.me/catalog/item/example",
            service: "yummyanime",
          },
        },
      }),
    ]));
  });

  it("does not reuse a native video's previous episode position after switching episodes", () => {
    const messages: any[] = [];
    const videoListeners: Record<string, () => void> = {};
    let currentEpisode = 1;
    const video = {
      currentTime: 80,
      duration: 100,
      paused: false,
      currentSrc: "https://cdn.example/yummy-video.mp4",
      src: "",
      getBoundingClientRect() { return { width: 640, height: 360 }; },
      addEventListener(type: string, listener: () => void) {
        videoListeners[type] = listener;
      },
    };
    const title = {
      textContent: "О моём перерождении в меч 2",
      getAttribute() { return null; },
    };
    const selectedEpisode = {
      get textContent() { return String(currentEpisode); },
    };
    const document = {
      title: "YummyAnime",
      documentElement: {},
      querySelector(selector: string) {
        return selector === "h1" ? title : null;
      },
      querySelectorAll(selector: string) {
        if (selector === "video") return [video];
        if (selector === '[data-selected="1"]') return [selectedEpisode];
        return [];
      },
    };
    const window = { addEventListener() {} };

    vm.runInNewContext(contentScript, {
      ...common,
      location: {
        hostname: "ru.yummyani.me",
        origin: "https://ru.yummyani.me",
        pathname: "/catalog/item/example",
        href: "https://ru.yummyani.me/catalog/item/example",
      },
      document,
      window,
      getComputedStyle() { return { display: "block", visibility: "visible" }; },
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message: unknown) { messages.push(message); },
        },
      },
      crypto: { randomUUID: () => "yummy-test-event" },
    });

    const tick = (time: number) => {
      video.currentTime = time;
      videoListeners.timeupdate?.();
    };

    tick(89);
    tick(90);
    let events = messages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ episode: 1, currentTimeSeconds: 90 });

    currentEpisode = 2;
    tick(91);
    tick(92);
    events = messages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(1);

    tick(0);
    for (let time = 4.5; time <= 90; time += 4.5) tick(time);
    events = messages.filter((message) => message.type === "MIDAHOSHI_AUTO_WATCH_EVENT");
    expect(events).toHaveLength(2);
    expect(events[1].event).toMatchObject({ episode: 2, currentTimeSeconds: 90 });
  });

  it("accepts YummyAnime metadata in the CVH player and preserves the source service", () => {
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
    const document = {
      title: "CVH Player",
      documentElement: {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };

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
      crypto: { randomUUID: () => "yummy-cvh-event" },
    });

    const dispatch = (event: any) => {
      for (const listener of listeners.message || []) listener(event);
    };
    dispatch({
      source: parentWindow,
      origin: "https://ru.yummyani.me",
      data: {
        type: "MIDAHOSHI_PARENT_METADATA",
        metadata: {
          title: "О моём перерождении в меч 2",
          episode: 7,
          service: "yummyanime",
          sourceUrl: "https://ru.yummyani.me/catalog/item/example",
        },
      },
    });

    const sendSample = (currentTime: number) => dispatch({
      source: window,
      origin: "https://player.cdnvideohub.com",
      data: {
        type: "MIDAHOSHI_CVH_STATE",
        state: {
          currentTime,
          duration: 100,
          paused: false,
          readyState: 4,
        },
      },
    });

    sendSample(90);
    sendSample(91);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].event).toMatchObject({
      service: "yummyanime",
      title: "О моём перерождении в меч 2",
      episode: 7,
      sourceUrl: "https://ru.yummyani.me/catalog/item/example",
    });
  });
});
