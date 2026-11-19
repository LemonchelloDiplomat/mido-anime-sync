const input = document.getElementById("appUrl");
const status = document.getElementById("status");

chrome.storage.local.get({ appUrl: "http://127.0.0.1:5173" }).then(({ appUrl }) => {
  input.value = appUrl;
});

document.getElementById("save").addEventListener("click", async () => {
  try {
    const url = new URL(input.value.trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    await chrome.storage.local.set({ appUrl: url.origin });
    status.textContent = "Сохранено.";
  } catch {
    status.textContent = "Введи корректный http:// или https:// адрес.";
  }
});