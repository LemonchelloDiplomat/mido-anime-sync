window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== "mido-anime-app") return;

  if (event.data?.type === "ACK_WATCH_EVENT" && typeof event.data.eventId === "string") {
    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_APP_ACK",
      eventId: event.data.eventId,
    });
    return;
  }

  if (event.data?.type === "REQUEST_ANIMEGO_IMPORT" && typeof event.data.importId === "string") {
    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_GET_ANIMEGO_IMPORT",
      importId: event.data.importId,
    }).then((result) => {
      window.postMessage({
        source: "mido-anime-extension",
        type: "ANIMEGO_IMPORT_RESULT",
        importId: event.data.importId,
        result,
      }, window.location.origin);
    }).catch((error) => {
      window.postMessage({
        source: "mido-anime-extension",
        type: "ANIMEGO_IMPORT_RESULT",
        importId: event.data.importId,
        result: { ok: false, error: error instanceof Error ? error.message : "Не удалось получить импорт AnimeGO." },
      }, window.location.origin);
    });
  }

  if (event.data?.type === "ACK_ANIMEGO_IMPORT" && typeof event.data.importId === "string") {
    chrome.runtime.sendMessage({
      type: "MIDAHOSHI_ACK_ANIMEGO_IMPORT",
      importId: event.data.importId,
    });
  }
});
