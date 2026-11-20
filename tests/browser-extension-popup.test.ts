import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const popupScript = await readFile(
  new URL("../browser-extension/popup.js", import.meta.url),
  "utf8",
);

class FakeElement {
  textContent = "";
  value = "";
  disabled = false;
  className = "";
  type = "";
  children: FakeElement[] = [];
  listeners = new Map<string, (...args: any[]) => unknown>();

  addEventListener(type: string, listener: (...args: any[]) => unknown) {
    this.listeners.set(type, listener);
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = [...children];
  }

  async click() {
    return await this.listeners.get("click")?.();
  }
}

function createPopupHarness(
  initialQueue: unknown[],
  confirmResult: boolean,
) {
  const ids = [
    "title", "episode", "status", "pending-list", "pending-count",
    "queue-diagnostics-summary", "queue-diagnostics-groups",
    "cleanup-duplicates", "clear-all-pending", "restore-queue-backup",
    "queue-maintenance-status", "scan", "send", "options",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const storage: Record<string, unknown> = { pendingWatchEvents: initialQueue };
  let storageChangeListener: ((changes: any, areaName: string) => void) | null = null;
  const confirmationMessages: string[] = [];

  const chromeMock = {
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          return { ...defaults, ...storage };
        },
        async set(values: Record<string, unknown>) {
          const changes: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { newValue: value };
          }
          Object.assign(storage, values);
          storageChangeListener?.(changes, "local");
        },
      },
      onChanged: {
        addListener(listener: (changes: any, areaName: string) => void) {
          storageChangeListener = listener;
        },
      },
    },
    runtime: {
      sendMessage: async () => undefined,
      openOptionsPage() {},
    },
    tabs: {
      async query() { return []; },
      async sendMessage() { return {}; },
      async create() {},
    },
  };

  vm.runInNewContext(popupScript, {
    chrome: chromeMock,
    document: {
      getElementById(id: string) {
        const element = elements.get(id);
        if (!element) throw new Error(`Unexpected element: ${id}`);
        return element;
      },
      createElement() {
        return new FakeElement();
      },
    },
    window: {
      confirm(message: string) {
        confirmationMessages.push(message);
        return confirmResult;
      },
    },
    URL,
    Date,
  });

  return {
    elements,
    storage,
    confirmationMessages,
  };
}

describe("browser extension popup queue maintenance", () => {
  it("backs up and removes every pending event, then allows restoring the queue", async () => {
    const originalQueue = [
      { eventId: "event-1", title: "Санка Рэа", episode: 1 },
      { eventId: "event-2", title: "Санка Рэа", episode: 2 },
      { eventId: "event-3", title: "Другой тайтл", episode: 1 },
    ];
    const harness = createPopupHarness(originalQueue, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clearButton = harness.elements.get("clear-all-pending")!;
    expect(clearButton.disabled).toBe(false);
    await clearButton.click();

    expect(harness.confirmationMessages).toHaveLength(1);
    expect(harness.confirmationMessages[0]).toContain("3 ожидающих передач");
    expect(harness.storage.pendingWatchEvents).toEqual([]);
    const backupKey = harness.storage.pendingWatchEventsLastBackupKey as string;
    expect(backupKey).toMatch(/^pendingWatchEventsBackup_/);
    expect(harness.storage[backupKey]).toEqual(originalQueue);
    expect(harness.elements.get("pending-count")?.textContent).toBe("(0)");
    expect(harness.elements.get("restore-queue-backup")?.disabled).toBe(false);

    await harness.elements.get("restore-queue-backup")!.click();
    expect(harness.storage.pendingWatchEvents).toEqual(originalQueue);
    expect(harness.elements.get("pending-count")?.textContent).toBe("(3)");
  });

  it("does not change the queue when deletion is cancelled", async () => {
    const originalQueue = [
      { eventId: "keep-me", title: "Санка Рэа", episode: 4 },
    ];
    const harness = createPopupHarness(originalQueue, false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await harness.elements.get("clear-all-pending")!.click();

    expect(harness.storage.pendingWatchEvents).toEqual(originalQueue);
    expect(harness.storage.pendingWatchEventsLastBackupKey).toBeUndefined();
    expect(harness.elements.get("queue-maintenance-status")?.textContent)
      .toContain("Удаление отменено");
  });

  it("disables the delete-all action when the queue is empty", async () => {
    const harness = createPopupHarness([], true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.elements.get("clear-all-pending")?.disabled).toBe(true);
    await harness.elements.get("clear-all-pending")!.click();
    expect(harness.confirmationMessages).toHaveLength(0);
  });
});
