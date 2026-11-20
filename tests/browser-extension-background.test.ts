import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const backgroundScript = await readFile(
  new URL("../browser-extension/background.js", import.meta.url),
  "utf8",
);

type HarnessOptions = {
  storage?: Record<string, unknown>;
  delayFirstQueueWrite?: boolean;
  failNextQueueWrite?: boolean;
};

function createBackgroundHarness(options: HarnessOptions = {}) {
  const storage = options.storage || { pendingWatchEvents: [] as unknown[] };
  let messageListener: ((message: any) => void) | null = null;
  let delayedQueueWriteUsed = false;
  let failNextQueueWrite = Boolean(options.failNextQueueWrite);

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
          if (Object.hasOwn(values, "pendingWatchEvents")) {
            if (failNextQueueWrite) {
              failNextQueueWrite = false;
              throw new Error("simulated storage quota failure");
            }
            if (options.delayFirstQueueWrite && !delayedQueueWriteUsed) {
              delayedQueueWriteUsed = true;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
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

  const warnings: unknown[][] = [];
  vm.runInNewContext(backgroundScript, {
    chrome: chromeMock,
    URL,
    OffscreenCanvas: class {
      getContext() { return drawingContext; }
    },
    crypto: { randomUUID: () => "generated-event-id" },
    console: { warn(...args: unknown[]) { warnings.push(args); } },
  });

  if (!messageListener) throw new Error("Background message listener was not registered");

  return {
    storage,
    warnings,
    dispatch(message: unknown) {
      messageListener?.(message);
    },
    async send(message: unknown) {
      messageListener?.(message);
      // Let the serialized background mutation and storage promises settle.
      await new Promise((resolve) => setTimeout(resolve, 35));
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

  it("treats YummyAnime regional and legacy subdomains as the same pending source", async () => {
    const harness = createBackgroundHarness();

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, sourceUrl: "https://ru.yummyani.me/catalog/item-1", eventId: "regional-event" },
    });
    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, sourceUrl: "https://old.yummyani.me/catalog/item-1", eventId: "legacy-event" },
    });

    expect(harness.storage.pendingWatchEvents).toHaveLength(1);
    expect(harness.storage.pendingWatchEvents).toMatchObject([
      { eventId: "regional-event", episode: 3 },
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

  it("preserves every pending event instead of silently dropping entries after the twentieth", async () => {
    const harness = createBackgroundHarness();

    for (let episode = 1; episode <= 25; episode += 1) {
      await harness.send({
        type: "MIDAHOSHI_AUTO_WATCH_EVENT",
        event: {
          ...watchEvent,
          episode,
          sourceUrl: `https://yummyani.me/catalog/item-${episode}`,
          eventId: `event-${episode}`,
        },
      });
    }

    expect(harness.storage.pendingWatchEvents).toHaveLength(25);
    expect(harness.storage.pendingWatchEvents).toMatchObject([
      { eventId: "event-1" },
      { eventId: "event-25" },
    ]);
  });

  it("serializes acknowledgement with incoming events so an acknowledged event cannot reappear", async () => {
    const harness = createBackgroundHarness({ delayFirstQueueWrite: true });

    const first = { ...watchEvent, eventId: "ack-me" };
    harness.storage.pendingWatchEvents = [];
    // Queue both messages without waiting between them to reproduce the
    // storage read/write race that can occur when the app acknowledges fast.
    harness.dispatch({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: first,
    });
    harness.dispatch({ type: "MIDAHOSHI_APP_ACK", eventId: "ack-me" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(harness.storage.pendingWatchEvents).toEqual([]);
  });

  it("keeps the existing queue after a storage write failure and accepts later events", async () => {
    const existingEvent = { ...watchEvent, eventId: "already-pending" };
    const harness = createBackgroundHarness({
      storage: { pendingWatchEvents: [existingEvent] },
      failNextQueueWrite: true,
    });

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, episode: 4, eventId: "first-write-fails" },
    });
    expect(harness.storage.pendingWatchEvents).toMatchObject([
      { eventId: "already-pending", episode: 3 },
    ]);
    expect(harness.warnings.length).toBeGreaterThan(0);

    await harness.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, episode: 5, eventId: "second-write-succeeds" },
    });
    expect(harness.storage.pendingWatchEvents).toMatchObject([
      { eventId: "already-pending", episode: 3 },
      { eventId: "second-write-succeeds", episode: 5 },
    ]);
  });

  it("keeps queued events across a background service worker restart", async () => {
    const firstWorker = createBackgroundHarness();
    await firstWorker.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, eventId: "survives-restart" },
    });

    const restartedWorker = createBackgroundHarness({ storage: firstWorker.storage });
    await restartedWorker.send({ type: "MIDAHOSHI_DISMISS_ALERT" });
    await restartedWorker.send({
      type: "MIDAHOSHI_AUTO_WATCH_EVENT",
      event: { ...watchEvent, eventId: "duplicate-after-restart" },
    });

    expect(restartedWorker.storage.pendingWatchEvents).toHaveLength(1);
    expect(restartedWorker.storage.pendingWatchEvents).toMatchObject([
      { eventId: "survives-restart", title: "Санка Рэа", episode: 3 },
    ]);
  });

  it("rejects malformed, unsupported, and below-threshold events", async () => {
    const harness = createBackgroundHarness();

    for (const event of [
      { ...watchEvent, eventId: "bad-scheme", sourceUrl: "javascript:alert(1)" },
      { ...watchEvent, eventId: "foreign-host", sourceUrl: "https://example.com/watch" },
      { ...watchEvent, eventId: "bad-episode", episode: 0 },
      { ...watchEvent, eventId: "below-threshold", currentTimeSeconds: 899 },
      { ...watchEvent, eventId: "bad-duration", durationSeconds: 0 },
    ]) {
      await harness.send({ type: "MIDAHOSHI_AUTO_WATCH_EVENT", event });
    }

    expect(harness.storage.pendingWatchEvents).toEqual([]);
  });
});
