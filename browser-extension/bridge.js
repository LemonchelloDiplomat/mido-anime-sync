window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== "mido-anime-app" || event.data?.type !== "ACK_WATCH_EVENT") return;
  if (typeof event.data.eventId !== "string") return;

  chrome.runtime.sendMessage({
    type: "MIDAHOSHI_APP_ACK",
    eventId: event.data.eventId,
  });
});