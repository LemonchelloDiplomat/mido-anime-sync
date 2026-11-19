import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const backgroundScript = await readFile(
  new URL("../browser-extension/background.js", import.meta.url),
  "utf8",
);

class FakeGradient {
  addColorStop() {}
}

class FakeCanvasContext {
  clearRect() {}
  save() {}
  restore() {}
  createLinearGradient() { return new FakeGradient(); }
  beginPath() {}
  roundRect() {}
  fill() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  arc() {}
  getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; }
}

class FakeOffscreenCanvas {
  context = new FakeCanvasContext();
  getContext() { return this.context; }
}

function createBackgroundHarness() {
  const storage: Record<string, any> = {};
  const messages: ((message: any) => void)[] = [];
  const calls = {
    setIcon: [] as any[],
    setBadgeText: [] as any[],
    setBadgeBackgroundColor: [] as any[],
    setTitle: [] as any[],
  };
  const chrome = {
    storage: {
      local: {
        async get(defaults: Record<string, any>) {
          return Object.fromEntries(
            Object.entries(defaults).map(([key, value]) => [
              key,
              storage[key] === undefined ? value : storage[key],
            ]),
          );
        },
        async set(values: Record<string, any>) {
          Object.assign(storage, values);
        },
      },
    },
    action: {
      async setIcon(value: any) { calls.setIcon.push(value); },
      async setBadgeText(value: any) { calls.setBadgeText.push(value); },
      async setBadgeBackgroundColor(value: any) { calls.setBadgeBackgroundColor.push(value); },
      async setTitle(value: any) { calls.setTitle.push(value); },
    },
    runtime: {
      onMessage: {
        addListener(listener: (message: any) => void) { messages.push(listener); },
      },
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      async get() { return { url: "https://animego.me/anime/example" }; },
      async sendMessage() {},
    },
  };

  vm.runInNewContext(backgroundScript, {
    chrome,
    OffscreenCanvas: FakeOffscreenCanvas,
    URL,
    Date,
    crypto: { randomUUID: () => "generated-event-id" },
    Number,
    String,
    Math,
  });

  const flush = async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  };
  return { storage, messages, calls, flush };
}

describe("browser extension toolbar state", () => {
  it("shows the tracked episode in red, dismisses the glow on click, and resets for another title", async () => {
    const harness = createBackgroundHarness();
    await harness.flush();

    const send = (message: any) => {
      for (const listener of harness.messages) listener(message);
    };

    send({
      type: "MIDAHOSHI_CURRENT_WATCH",
      title: "First Anime",
      episode: 5,
    });
    await harness.flush();

    expect(harness.storage.toolbarWatchState).toMatchObject({
      title: "First Anime",
      episode: null,
      alerted: false,
    });

    send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: {
        eventId: "episode-five",
        service: "animego",
        title: "First Anime",
        episode: 5,
        sourceUrl: "https://animego.me/anime/first",
        currentTimeSeconds: 91,
        durationSeconds: 100,
      },
    });
    await harness.flush();

    expect(harness.storage.toolbarWatchState).toMatchObject({
      title: "First Anime",
      episode: 5,
      alerted: true,
    });
    expect(harness.storage.pendingWatchEvents).toHaveLength(1);
    expect(harness.calls.setBadgeText.at(-1)).toEqual({ text: "5" });
    expect(harness.calls.setBadgeBackgroundColor.at(-1)).toEqual({ color: "#e3264f" });

    send({ type: "MIDAHOSHI_DISMISS_ALERT" });
    await harness.flush();

    expect(harness.storage.toolbarWatchState).toMatchObject({
      title: "First Anime",
      episode: 5,
      alerted: false,
    });
    expect(harness.calls.setBadgeText.at(-1)).toEqual({ text: "5" });
    expect(harness.calls.setBadgeBackgroundColor.at(-1)).toEqual({ color: "#594b70" });
    expect(harness.storage.pendingWatchEvents).toHaveLength(1);

    send({
      type: "MIDAHOSHI_CURRENT_WATCH",
      title: "Second Anime",
      episode: 2,
    });
    await harness.flush();

    expect(harness.storage.toolbarWatchState).toMatchObject({
      title: "Second Anime",
      episode: null,
      alerted: false,
    });
    expect(harness.calls.setBadgeText.at(-1)).toEqual({ text: "" });
  });
});
