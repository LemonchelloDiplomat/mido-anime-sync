const input = document.getElementById("appUrl");
const status = document.getElementById("status");
const allowedHosts = new Set(["127.0.0.1", "localhost"]);
const allowedPorts = new Set(["5173", "3001", "4173"]);

function parseLocalAppUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !allowedHosts.has(url.hostname) ||
    !allowedPorts.has(url.port || "80")
  ) {
    throw new Error("unsupported local app address");
  }
  return url.origin;
}

chrome.storage.local.get({ appUrl: "http://127.0.0.1:5173" }).then(({ appUrl }) => {
  input.value = appUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  try {
    const appUrl = parseLocalAppUrl(input.value.trim());
    await chrome.storage.local.set({ appUrl });
    status.textContent = "Сохранено.";
  } catch {
    status.textContent = "Разрешены только локальные адреса localhost / 127.0.0.1 на портах 5173, 3001 или 4173.";
  }
});