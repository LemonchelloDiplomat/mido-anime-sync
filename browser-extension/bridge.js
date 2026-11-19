chrome.runtime.sendMessage({ type: "MIDA_APP_READY" });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "MIDA_WATCH_EVENT" || !message.event) return;
  window.postMessage({
    source: "mido-anime-watch-extension",
    type: "WATCH_EVENT",
    event: message.event,
  }, window.location.origin);
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== "mido-anime-app" || event.data?.type !== "ACK_WATCH_EVENT") return;
  chrome.runtime.sendMessage({
    type: "MIDA_APP_ACK",
    eventId: event.data.eventId,
  });
});