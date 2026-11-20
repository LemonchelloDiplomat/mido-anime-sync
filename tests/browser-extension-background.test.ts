import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const backgroundScript = await readFile(
  new URL("../browser-extension/background.js", import.meta.url),
  "utf8",
);

function createBackgroundHarness() {
  const storage: Record<string, unknown> = { pendingWatchEvents: [] };
  let messageListener: ((message: any) => void) | null = null;

  const drawingContext = {
    clearRect() {}, save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {},
    moveTo() {}, lineTo() {}, stroke() {}, arc() {}, getImageData() { return {}; },
    createLinearGradient() { return { addColorStop() {} }; },
    fillStyle: "", strokeStyle: "", shadowColor: "", shadowBlur: 0,
    lineCap: "", lineJoin: "", lineWidth: 1,
  };

  const chromeMock = {
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          return { ...defaults, ...storage };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(storage, values);
        },
      },
    },
    action: {
      async setIcon() {},
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      async sendMessage() {},
    },
    runtime: {
      onMessage: {
        addListener(listener: (message: any) => void) {
          messageListener = listener;
        },
      },
    },
  };

  vm.runInNewContext(backgroundScript, {
    chrome: chromeMock,
    URL,
    OffscreenCanvas: class {
      getContext() { return drawingContext; }
    },
    crypto: { randomUUID: () => "generated-event-id" },
    console,
  });

  if (!messageListener) throw new Error("Background message listener was not registered");

  return {
    storage,
    async send(message: unknown) {
      messageListener?.(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const watchEvent = {
  service: "yummyanime",
  title: "Санка Рэа",
  episode: 3,
  sourceUrl: "https://yummyani.me/catalog/item-1?translation=2",
  currentTimeSeconds: 900,
  durationSeconds: 1000,
};

describe("browser extension pending watch queue", () => {
  it("does not enqueue the same anime episode and source twice while it is pending", async () => {
    const harness = createBackgroundHarness();

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, eventId: "first-event" },
    });
    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, sourceUrl: "https://yummyani.me/catalog/item-1#player", eventId: "second-event" },
    });

    expect(harness.storage.pendingWatchEvents).toHaveLength(1);
    expect(harness.storage.pendingWatchEvents).toMatchObject([
      { eventId: "first-event", title: "Санка Рэа", episode: 3 },
    ]);
  });

  it("keeps different episodes separate and allows a new event after acknowledgement", async () => {
    const harness = createBackgroundHarness();

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, eventId: "episode-three" },
    });
    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, episode: 4, eventId: "episode-four" },
    });
    expect(harness.storage.pendingWatchEvents).toHaveLength(2);

    await harness.send({ type: "MIDAHOSHI_APP_ACK", eventId: "episode-three" });
    expect(harness.storage.pendingWatchEvents).toHaveLength(1);

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, eventId: "episode-three-rewatch" },
    });
    expect(harness.storage.pendingWatchEvents).toHaveLength(2);
  });
});
