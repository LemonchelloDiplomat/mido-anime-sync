(() => {
  if (window.top !== window || !/^\/(?:profile|user)\//i.test(location.pathname)) return;
  if (document.getElementById("mido-animego-import")) return;

  const TYPE_LABELS = {
    1: "Смотрю", 2: "Просмотрено", 3: "Отложено",
    4: "Брошено", 5: "Запланировано", 6: "Пересматриваю",
  };
  const type = Number(new URLSearchParams(location.search).get("type") || 1);
  if (!TYPE_LABELS[type]) return;

  const panel = document.createElement("div");
  panel.id = "mido-animego-import";
  panel.style.cssText = "position:fixed;z-index:2147483647;right:18px;bottom:18px;display:flex;gap:8px;align-items:center;max-width:min(520px,calc(100vw - 36px));padding:10px 12px;border:1px solid #8b78bb;border-radius:12px;background:#171522;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px #0008";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Передать список в Mido";
  button.style.cssText = "border:0;border-radius:8px;padding:9px 12px;background:#a98ad9;color:#171522;font-weight:700;cursor:pointer;white-space:nowrap";
  const status = document.createElement("span");
  status.textContent = "AnimeGO · " + TYPE_LABELS[type];
  panel.append(button, status);
  (document.body || document.documentElement).append(panel);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parseScore = (card) => {
    const node = card.querySelector("[data-rating-value]");
    const raw = node?.getAttribute("data-rating-value") || node?.textContent || "";
    const match = String(raw).replace(",", ".").match(/(?:^|\D)(10(?:\.0+)?|[1-9](?:\.\d+)?)(?:$|\D)/);
    return match ? Number(match[1]) : null;
  };
  const parseCard = (card) => {
    const anchor = card.querySelector(".user-mylist__title a");
    const href = anchor?.getAttribute("href") || "";
    let url;
    try { url = new URL(href, location.origin); } catch { return null; }
    if (url.origin !== location.origin || !/^\/anime\//.test(url.pathname)) return null;
    const id = url.pathname.match(/-(\d+)\/?$/)?.[1];
    const title = (anchor?.textContent || "").trim();
    if (!id || !title) return null;
    const originalTitle = (card.querySelector(".fw-lighter.small")?.textContent || "").trim();
    const image = card.querySelector("img");
    const posterUrl = image?.currentSrc || image?.src || null;
    return { animeId: id, title, originalTitle: originalTitle || null, score: parseScore(card), posterUrl, href: url.pathname };
  };

  async function loadAllRows() {
    const expectedNode = document.querySelector('a[href$="?type=' + type + '"] span.badge');
    const expected = Number.parseInt(expectedNode?.textContent || "", 10) || null;
    let lastCount = -1;
    let stable = 0;
    let attempts = 0;
    while (attempts < 180 && stable < 5) {
      attempts += 1;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      await sleep(650);
      const count = document.querySelectorAll(".user-mylist__item").length;
      status.textContent = "Загружаем список: " + count + (expected ? " / " + expected : "") + "…";
      if (expected && count >= expected) break;
      if (count === lastCount) stable += 1;
      else stable = 0;
      lastCount = count;
    }
    return [...document.querySelectorAll(".user-mylist__item")].map(parseCard).filter(Boolean);
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.style.opacity = "0.6";
    try {
      status.textContent = "Догружаем все карточки списка…";
      const entries = await loadAllRows();
      if (!entries.length) throw new Error("Не найдены карточки .user-mylist__item. Проверь, что список открыт и загружен.");
      status.textContent = "Передаём " + entries.length + " записей в локальное приложение…";
      const result = await chrome.runtime.sendMessage({
        type: "MIDAHOSHI_ANIMEGO_LIST_EXPORT",
        payload: { listType: type, sourceUrl: location.origin + location.pathname + location.search, entries },
      });
      if (!result?.ok) throw new Error(result?.error || "Расширение не смогло передать список.");
      status.textContent = "Готово: " + entries.length + " записей. Открой Mido и проверь предпросмотр импорта.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Не удалось передать список.";
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
    }
  });
})();
