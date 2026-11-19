const APP_URLS = [
  "http://127.0.0.1:5173/*",
  "http://localhost:5173/*",
  "http://127.0.0.1:3001/*",
  "http://localhost:3001/*",
];
const QUEUE_KEY = "pendingWatchEvents";

async function readQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
}

async function writeQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function deliverToTab(tabId, queue) {
  for (const event of queue) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "MIDA_WATCH_EVENT", event });
    } catch {
      // The app tab may have navigated or its bridge may not be ready yet.
      return;
    }
  }
}

async function deliverToOpenApps() {
  const [queue, tabs] = await Promise.all([
    readQueue(),
    chrome.tabs.query({ url: APP_URLS }),
  ]);
  if (queue.length === 0) return;
  for (const tab of tabs) {
    if (typeof tab.id === "number") await deliverToTab(tab.id, queue);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "MIDA_WATCH_EVENT" && message.event) {
    void (async () => {
      const queue = await readQueue();
      if (!queue.some((item) => item.eventId === message.event.eventId)) {
        queue.push(message.event);
        await writeQueue(queue.slice(-30));
      }
      await deliverToOpenApps();
    })();
    return;
  }

  if (message?.type === "MIDA_APP_READY" && typeof sender.tab?.id === "number") {
    void readQueue().then((queue) => deliverToTab(sender.tab.id, queue));
    return;
  }

  if (message?.type === "MIDA_APP_ACK" && typeof message.eventId === "string") {
    void readQueue().then((queue) =>
      writeQueue(queue.filter((item) => item.eventId !== message.eventId)),
    );
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && APP_URLS.some((pattern) => {
    const prefix = pattern.replace("*", "");
    return tab.url.startsWith(prefix);
  })) {
    void deliverToOpenApps();
  }
});