import { useCallback, useEffect, useState } from "react";
import type { StreamingProviderId } from "../services/streaming-provider.js";
import type { AnimeGoNetworkInspection, AnimeGoProgressSnapshot, AnimeGoWriteInspection, StreamingAccountStatus } from "../services/streaming-account-manager.js";
import type { StreamingRuntime } from "../services/platform/streaming-runtime.js";
import type { AnimeGoAccountListResponse } from "../services/platform/web-streaming-account-manager.js";

interface ProviderCard {
  id: StreamingProviderId;
  name: string;
  description: string;
  limitation: string;
}

const PROVIDERS: ProviderCard[] = [
  {
    id: "animego",
    name: "AnimeGO",
    description: "Аккаунт и личный список просмотра",
    limitation: "Вход через встроенное окно Windows. Личный список читается через защищённую сессию; тестовая запись статуса выполняется через авторизованный WebView2 с проверкой результата.",
  },
  {
    id: "anixart",
    name: "Anixart",
    description: "Аккаунт и закладки",
    limitation: "Официальный разрешённый API для сторонней авторизации не подтверждён. Приватные API-вызовы не используются.",
  },
];

function describeOperationError(cause: unknown, fallback: string): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (cause && typeof cause === "object") {
    const value = cause as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (typeof value.error === "string" && value.error.trim()) return value.error;
    if (typeof value.code === "string" && value.code.trim()) return "Ошибка Tauri: " + value.code;
    try {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the stable user-facing message.
    }
  }
  return fallback;
}

interface Props {
  runtime: StreamingRuntime | null;
  onRetryRuntime?: () => void | Promise<void>;
  runtimeRefreshing?: boolean;
  runtimeRefreshError?: string;
  onImportAnimeGoList?: (result: AnimeGoAccountListResponse) => Promise<void>;
}

export function StreamingAccountManagerPanel({
  runtime,
  onRetryRuntime,
  runtimeRefreshing = false,
  runtimeRefreshError = "",
  onImportAnimeGoList,
}: Props) {
  const [statuses, setStatuses] = useState<Partial<Record<StreamingProviderId, StreamingAccountStatus>>>({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<StreamingProviderId | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listImporting, setListImporting] = useState(false);
  const [listImportMessage, setListImportMessage] = useState("");
  const [authWindowOpened, setAuthWindowOpened] = useState(false);
  const [listPreview, setListPreview] = useState<AnimeGoAccountListResponse | null>(null);
  const [selectedAnimeGoItemId, setSelectedAnimeGoItemId] = useState("");
  const [targetAnimeGoStatus, setTargetAnimeGoStatus] = useState<"PLANNING" | "WATCHING" | "COMPLETED" | "ON_HOLD" | "DROPPED" | "REWATCHING">("WATCHING");
  const [statusWriting, setStatusWriting] = useState(false);
  const [statusWriteMessage, setStatusWriteMessage] = useState("");
  const [targetAnimeGoRating, setTargetAnimeGoRating] = useState(8);
  const [ratingWriting, setRatingWriting] = useState(false);
  const [ratingWriteMessage, setRatingWriteMessage] = useState("");
  const [targetAnimeGoProgress, setTargetAnimeGoProgress] = useState("0");
  const [progressSnapshot, setProgressSnapshot] = useState<AnimeGoProgressSnapshot | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressWriting, setProgressWriting] = useState(false);
  const [progressWriteMessage, setProgressWriteMessage] = useState("");

  const [writeInspection, setWriteInspection] = useState<AnimeGoWriteInspection | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [networkInspection, setNetworkInspection] = useState<AnimeGoNetworkInspection | null>(null);
  const [networkInspectionLoading, setNetworkInspectionLoading] = useState(false);
  const [networkWindowOpening, setNetworkWindowOpening] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!runtime) {
      setStatuses({});
      return;
    }

    setLoading(true);
    setError("");
    try {
      const next = await Promise.all(PROVIDERS.map(async ({ id }) => {
        const status = runtime.accounts.hasAdapter(id)
          ? await runtime.accounts.restore(id)
          : runtime.accounts.getStatus(id);
        return [id, status] as const;
      }));
      setStatuses(Object.fromEntries(next));
    } catch {
      setError("Не удалось проверить состояние аккаунтов. Проверь локальный API.");
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function beginAnimeGoWebAuth() {
    if (!runtime?.accounts.beginConnect) return;
    setConnecting(true);
    setError("");
    try {
      await runtime.accounts.beginConnect("animego");
      setAuthWindowOpened(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть окно AnimeGO.");
    } finally {
      setConnecting(false);
    }
  }

  async function completeAnimeGoWebAuth() {
    if (!runtime?.accounts.completeConnect) return;
    setConnecting(true);
    setError("");
    try {
      await runtime.accounts.completeConnect("animego");
      setAuthWindowOpened(false);
      setListPreview(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AnimeGO пока не подтвердил вход.");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(provider: StreamingProviderId) {
    if (!runtime) return;
    setDisconnecting(provider);
    setError("");
    try {
      await runtime.accounts.disconnect(provider);
      if (provider === "animego") { setListPreview(null); setAuthWindowOpened(false); }
      await refresh();
    } catch {
      setError("Не удалось отключить аккаунт. Проверь состояние подключения и повтори попытку.");
    } finally {
      setDisconnecting(null);
    }
  }

  async function loadAnimeGoList() {
    if (!runtime?.accounts.fetchList) return;
    setListLoading(true);
    setError("");
    try {
      const result = await runtime.accounts.fetchList("animego") as AnimeGoAccountListResponse;
      setListPreview(result);
      const preferred = result.items.find((item) => /91\\s*days|91\\s*ден/i.test(item.title + " " + (item.alternativeTitle ?? "")));
      setSelectedAnimeGoItemId(preferred?.listEntryId ?? result.items[0]?.listEntryId ?? "");
      setTargetAnimeGoRating(preferred?.score ?? result.items[0]?.score ?? 8);
      setTargetAnimeGoProgress(String(preferred?.episodesWatched ?? result.items[0]?.episodesWatched ?? 0));
      setProgressSnapshot(null);
      setRatingWriteMessage("");
      setProgressWriteMessage("");
      setStatusWriteMessage("");
      setWriteInspection(null);
      setListImportMessage("");
    } catch (cause) {
      const message = typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
            ? cause.message
            : "Не удалось загрузить личный список AnimeGO.";
      setError(message);
    } finally {
      setListLoading(false);
    }
  }

  async function inspectAnimeGoWriteCapabilities() {
    const firstItem = listPreview?.items[0];
    if (!firstItem || !runtime?.accounts.inspectWriteCapabilities) return;
    setInspectionLoading(true);
    setError("");
    setWriteInspection(null);
    try {
      const result = await runtime.accounts.inspectWriteCapabilities("animego", firstItem.url);
      setWriteInspection(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось исследовать формы AnimeGO.");
    } finally {
      setInspectionLoading(false);
    }
  }

  async function openAnimeGoSessionWindow() {
    if (!runtime?.accounts.openSessionWindow) return;
    setNetworkWindowOpening(true);
    setError("");
    setNetworkInspection(null);
    try {
      await runtime.accounts.openSessionWindow("animego");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть окно AnimeGO.");
    } finally {
      setNetworkWindowOpening(false);
    }
  }

  async function inspectAnimeGoNetwork() {
    if (!runtime?.accounts.inspectNetwork) return;
    setNetworkInspectionLoading(true);
    setError("");
    setNetworkInspection(null);
    try {
      const result = await runtime.accounts.inspectNetwork("animego");
      setNetworkInspection(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось собрать сетевые метаданные AnimeGO.");
    } finally {
      setNetworkInspectionLoading(false);
    }
  }

  async function writeAnimeGoStatus() {
    const item = listPreview?.items.find((candidate) => candidate.listEntryId === selectedAnimeGoItemId);
    if (!item || !runtime?.accounts.setStatus) return;
    setStatusWriting(true);
    setError("");
    setStatusWriteMessage("");
    try {
      const result = await runtime.accounts.setStatus("animego", item.url, targetAnimeGoStatus);
      if (!result.verified) {
        setStatusWriteMessage("Запрос отправлен, но AnimeGO не подтвердил новый статус. Проверь список на сайте.");
        return;
      }
      await loadAnimeGoList();
      setStatusWriteMessage("Статус подтверждён AnimeGO. HTTP " + result.httpStatus + " · " + result.durationMs + " мс.");
    } catch (cause) {
      const detail = typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
            ? cause.message
            : cause && typeof cause === "object" && "error" in cause && typeof cause.error === "string"
              ? cause.error
              : cause && typeof cause === "object" && "code" in cause
                ? "Ошибка Tauri: " + String(cause.code)
                : JSON.stringify(cause);
      setError(detail && detail !== "{}" ? detail : "Не удалось записать статус через AnimeGO. Подробности отсутствуют в ответе Tauri.");
    } finally {
      setStatusWriting(false);
    }
  }


  async function writeAnimeGoRating() {
    const item = listPreview?.items.find((candidate) => candidate.listEntryId === selectedAnimeGoItemId);
    if (!item || !runtime?.accounts.setRating) return;
    if (!Number.isInteger(targetAnimeGoRating) || targetAnimeGoRating < 1 || targetAnimeGoRating > 10) {
      setRatingWriteMessage("Оценка должна быть целым числом от 1 до 10.");
      return;
    }
    setRatingWriting(true);
    setError("");
    setRatingWriteMessage("");
    try {
      const result = await runtime.accounts.setRating("animego", item.url, targetAnimeGoRating);
      if (!result.verified) {
        setRatingWriteMessage("AnimeGO получил запрос, но сохранение оценки не подтверждено. Проверь страницу тайтла.");
        return;
      }
      const confirmedRating = result.verifiedRating ?? result.rating;
      setListPreview((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.listEntryId === item.listEntryId
          ? { ...candidate, score: confirmedRating }
          : candidate),
      } : current);
      setRatingWriteMessage("Оценка подтверждена AnimeGO: " + confirmedRating + "/10 · HTTP " + result.httpStatus + " · " + result.durationMs + " мс.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось записать оценку AnimeGO.");
    } finally {
      setRatingWriting(false);
    }
  }

  async function readAnimeGoProgress() {
    const item = listPreview?.items.find((candidate) => candidate.listEntryId === selectedAnimeGoItemId);
    if (!selectedAnimeGoItemId) {
      setProgressWriteMessage("Сначала выбери тайтл AnimeGO.");
      return;
    }
    if (!item) {
      setProgressWriteMessage("Выбранный тайтл не найден в загруженном списке. Обнови список AnimeGO и выбери его снова.");
      return;
    }
    if (!runtime?.accounts.fetchProgress) {
      setProgressWriteMessage("Чтение прогресса недоступно в текущей версии runtime. Перезапусти приложение и проверь обновление.");
      return;
    }

    setProgressLoading(true);
    setError("");
    setProgressWriteMessage("Запрашиваем прогресс AnimeGO для: " + item.title + "…");
    try {
      const result = await runtime.accounts.fetchProgress("animego", item.url);
      setProgressSnapshot(result);
      setTargetAnimeGoProgress(String(result.watchedEpisodeNumber));
      setProgressWriteMessage("Прочитано с AnimeGO: просмотрено " + result.watchedEpisodeNumber + " из " + result.episodes.length + " эпизодов · HTTP " + result.httpStatus + " · " + result.durationMs + " мс.");
    } catch (cause) {
      setProgressSnapshot(null);
      setProgressWriteMessage("Ошибка чтения прогресса: " + describeOperationError(cause, "AnimeGO не вернул подробности ошибки."));
    } finally {
      setProgressLoading(false);
    }
  }

  async function writeAnimeGoProgress() {
    const item = listPreview?.items.find((candidate) => candidate.listEntryId === selectedAnimeGoItemId);
    if (!item || !runtime?.accounts.setProgress) return;
    const progress = Number(targetAnimeGoProgress);
    if (!Number.isInteger(progress) || progress < 0) {
      setProgressWriteMessage("Укажи целое количество просмотренных эпизодов, начиная с 0.");
      return;
    }
    if (item.episodesTotal !== null && progress > item.episodesTotal) {
      setProgressWriteMessage("У этого тайтла всего " + item.episodesTotal + " эпизодов.");
      return;
    }
    setProgressWriting(true);
    setError("");
    setProgressWriteMessage("");
    try {
      const result = await runtime.accounts.setProgress("animego", item.url, progress);
      if (!result.verified) {
        setProgressWriteMessage("AnimeGO получил запрос, но новый прогресс не подтверждён. Прочитай прогресс повторно и проверь сайт.");
        return;
      }
      setProgressSnapshot((current) => current ? {
        ...current,
        watchedEpisodeNumber: result.watchedEpisodeNumber,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        episodes: current.episodes.map((episode) => ({
          ...episode,
          watched: episode.episodeNumber <= result.watchedEpisodeNumber,
        })),
      } : current);
      setListPreview((current) => current ? {
        ...current,
        items: current.items.map((candidate) => candidate.listEntryId === item.listEntryId
          ? { ...candidate, episodesWatched: result.watchedEpisodeNumber }
          : candidate),
      } : current);
      setProgressWriteMessage("Прогресс подтверждён AnimeGO: " + result.watchedEpisodeNumber + " эпизодов · изменено: " + result.changedEpisodes + " · HTTP " + result.httpStatus + " · " + result.durationMs + " мс.");
    } catch (cause) {
      const detail = typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
            ? cause.message
            : cause && typeof cause === "object" && "error" in cause && typeof cause.error === "string"
              ? cause.error
              : cause && typeof cause === "object" && "code" in cause
                ? "Ошибка Tauri: " + String(cause.code)
                : JSON.stringify(cause);
      setProgressWriteMessage(detail && detail !== "{}"
        ? "Ошибка записи прогресса: " + detail
        : "Не удалось записать прогресс AnimeGO. Подробности отсутствуют в ответе Tauri.");
    } finally {
      setProgressWriting(false);
    }
  }

  async function importAnimeGoList() {
    if (!listPreview || !onImportAnimeGoList) return;
    setListImporting(true);
    setError("");
    setListImportMessage("");
    try {
      await onImportAnimeGoList(listPreview);
      setListImportMessage("Список AnimeGO добавлен в локальную библиотеку. Удаления и запись на сайт не выполнялись.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось импортировать список AnimeGO.");
    } finally {
      setListImporting(false);
    }
  }

  return (
    <section className="native-account-manager">
      <div className="section-heading">
        <div>
          <div className="eyebrow">STREAMING ACCOUNT MANAGER</div>
          <h2>Аккаунты AnimeGO и Anixart</h2>
          <p>Сессии хранятся отдельно от локальной библиотеки и не попадают в экспорт данных.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => runtime ? void refresh() : void onRetryRuntime?.()}
          disabled={loading || runtimeRefreshing}
        >
          {loading || runtimeRefreshing ? "Проверяем..." : "Обновить"}
        </button>
      </div>

      <div className="native-account-runtime-note">
        <span className={"native-account-runtime-dot" + (runtime ? " is-ready" : "")} />
        {runtime
          ? runtime.platform === "windows-native"
            ? "Windows Credential Manager подключён. Секреты хранятся в системном хранилище."
            : runtime.platform === "capacitor-android"
              ? "Android Keystore подключён. Секреты хранятся в системном хранилище."
              : "Веб-режим: локальный API доступен. Сессия хранится на стороне локального сервера, отдельно от браузера и библиотеки."
          : runtimeRefreshError || "Локальный API недоступен. В браузере аккаунты не подключаются."}
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}

      <div className="native-account-list">
        {PROVIDERS.map((provider) => {
          const supported = runtime?.accounts.hasAdapter(provider.id) ?? false;
          const status = statuses[provider.id];
          const connected = status?.state === "connected" && status.connected;
          const stateLabel = !runtime
            ? "Недоступно в браузере"
            : !supported
              ? "Авторизация не реализована"
              : connected
                ? "Подключён"
                : authWindowOpened && provider.id === "animego"
                  ? "Ожидаем вход на сайте"
                  : status?.state === "expired"
                  ? "Сессия истекла"
                  : status?.state === "error"
                    ? "Ошибка проверки"
                    : "Не подключён";

          return (
            <article className="native-account-card" key={provider.id}>
              <div className={"native-account-logo native-account-logo--" + provider.id}>
                {provider.id === "animego" ? "AG" : "AX"}
              </div>
              <div className="native-account-info">
                <div className="native-account-title-row">
                  <h3>{provider.name}</h3>
                  <span className={"integration-state" + (connected ? " connected" : "")}>{stateLabel}</span>
                </div>
                <p>{provider.description}</p>
                <small>{connected && status?.accountLabel ? "Аккаунт: " + status.accountLabel : provider.limitation}</small>

                {provider.id === "animego" && runtime?.platform === "windows-native" && supported && !connected && (
                  <div className="native-account-connect-form">
                    {!authWindowOpened ? (
                      <>
                        <button className="secondary-button" type="button" onClick={() => void beginAnimeGoWebAuth()} disabled={connecting}>
                          {connecting ? "Открываем сайт..." : "Войти через сайт AnimeGO"}
                        </button>
                        <small>Откроется встроенное окно AnimeGO. Введи данные непосредственно на сайте, приложение не увидит пароль.</small>
                      </>
                    ) : (
                      <>
                        <p>Заверши вход в открывшемся окне AnimeGO, затем подтверди его здесь.</p>
                        <button className="secondary-button" type="button" onClick={() => void completeAnimeGoWebAuth()} disabled={connecting}>
                          {connecting ? "Проверяем сессию..." : "Я вошёл, проверить авторизацию"}
                        </button>
                        <button className="secondary-button" type="button" onClick={() => void beginAnimeGoWebAuth()} disabled={connecting}>
                          Открыть окно входа снова
                        </button>
                        <small>Сессия проверяется и сохраняется в Windows Credential Manager. Cookies не передаются в интерфейс.</small>
                      </>
                    )}
                  </div>
                )}
                {provider.id === "animego" && runtime?.platform === "web-local" && !connected && (
                  <small>Вход через встроенное окно доступен в Windows-приложении. Запусти его командой npm run tauri:dev.</small>
                )}
              </div>

              {connected && runtime ? (
                <>
                <div className="native-account-actions">
                  {provider.id === "animego" && runtime.platform === "windows-native" && runtime.accounts.openSessionWindow && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void openAnimeGoSessionWindow()}
                      disabled={networkWindowOpening || networkInspectionLoading || disconnecting !== null}
                    >
                      {networkWindowOpening ? "Открываем..." : "Открыть окно AnimeGO"}
                    </button>
                  )}
                  {provider.id === "animego" && runtime.platform === "windows-native" && runtime.accounts.inspectNetwork && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void inspectAnimeGoNetwork()}
                      disabled={networkInspectionLoading || networkWindowOpening || disconnecting !== null}
                    >
                      {networkInspectionLoading ? "Наблюдаем 90 секунд..." : "Начать пассивное наблюдение"}
                    </button>
                  )}
                  {provider.id === "animego" && runtime.accounts.fetchList && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void loadAnimeGoList()}
                      disabled={listLoading || disconnecting !== null}
                    >
                      {listLoading ? "Загружаем..." : "Получить список"}
                    </button>
                  )}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void disconnect(provider.id)}
                    disabled={disconnecting !== null || listLoading}
                  >
                    {disconnecting === provider.id ? "Отключаем..." : "Отключить"}
                  </button>
                </div>
                {provider.id === "animego" && runtime.platform === "windows-native" && (
                  <small>Открой окно AnimeGO, перейди на страницу нужного тайтла и только затем запусти наблюдение. Во время 90 секунд выполни обычные действия на сайте. Инспектор не нажимает кнопки и не меняет данные.</small>
                )}
                </>
              ) : provider.id !== "animego" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled
                  title={provider.limitation}
                >
                  Подключить
                </button>
              ) : null}
            </article>
          );
        })}
      </div>

      {listPreview && (
        <div className="native-account-list-preview">
          <h3>Личный список AnimeGO получен</h3>
          <p>Найдено записей: <strong>{listPreview.total}</strong>. Проверь результат перед импортом. Удаления из локальной библиотеки не выполняются.</p>
          <div className="native-account-list-counts">
            {listPreview.lists.map((list) => (
              <span key={list.listType}>Тип {list.listType}: {list.itemCount}</span>
            ))}
          </div>
          <ul>
            {listPreview.items.slice(0, 12).map((item) => (
              <li key={item.listEntryId}>
                {item.title}
                <small>Тип {item.listType}{item.episodesWatched !== null ? " · просмотрено " + item.episodesWatched : ""}</small>
              </li>
            ))}
          </ul>
          {listPreview.total > 12 && <small>И ещё {listPreview.total - 12} записей.</small>}
          {onImportAnimeGoList && <button className="secondary-button" type="button" onClick={() => void importAnimeGoList()} disabled={listImporting || listLoading}>{listImporting ? "Импортируем..." : "Импортировать в библиотеку"}</button>}
          {runtime?.platform === "windows-native" && runtime.accounts.setStatus && listPreview.items.length > 0 && (
            <div className="native-account-status-test">
              <h4>Тест записи статуса через WebView2</h4>
              <label>
                Тайтл AnimeGO
                <select
                  value={selectedAnimeGoItemId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextItem = listPreview.items.find((item) => item.listEntryId === nextId);
                    setSelectedAnimeGoItemId(nextId);
                    setTargetAnimeGoRating(nextItem?.score ?? 8);
                    setTargetAnimeGoProgress(String(nextItem?.episodesWatched ?? 0));
                    setProgressSnapshot(null);
                    setRatingWriteMessage("");
                    setProgressWriteMessage("");
                  }}
                  disabled={statusWriting || ratingWriting || progressLoading || progressWriting}
                >
                  {listPreview.items.map((item) => (
                    <option key={item.listEntryId} value={item.listEntryId}>{item.title} · тип {item.listType}</option>
                  ))}
                </select>
              </label>
              <label>
                Новый статус
                <select value={targetAnimeGoStatus} onChange={(event) => setTargetAnimeGoStatus(event.target.value as typeof targetAnimeGoStatus)} disabled={statusWriting}>
                  <option value="PLANNING">В планах</option>
                  <option value="WATCHING">Смотрю</option>
                  <option value="COMPLETED">Просмотрено</option>
                  <option value="ON_HOLD">Отложено</option>
                  <option value="DROPPED">Брошено</option>
                  <option value="REWATCHING">Пересматриваю</option>
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={() => void writeAnimeGoStatus()} disabled={statusWriting || !selectedAnimeGoItemId}>
                {statusWriting ? "Записываем и проверяем..." : "Записать статус на AnimeGO"}
              </button>
              {statusWriteMessage && <p role="status">{statusWriteMessage}</p>}
              <small>Изменится только выбранный тайтл. Перед записью убедись, что выбран правильный аккаунт и статус.</small>
            </div>
          )}


          {runtime?.platform === "windows-native" && listPreview.items.length > 0 && (
            <div className="native-account-status-test">
              <h4>Тест записи оценки и прогресса</h4>
              <p>Операции выполняются только для выбранного выше тайтла и проверяются повторным чтением AnimeGO.</p>
              {runtime.accounts.setRating && (
                <>
                  <label>
                    Оценка AnimeGO (1–10)
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={targetAnimeGoRating}
                      onChange={(event) => setTargetAnimeGoRating(Number(event.target.value))}
                      disabled={ratingWriting || statusWriting || progressWriting}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void writeAnimeGoRating()}
                    disabled={ratingWriting || statusWriting || progressWriting || !selectedAnimeGoItemId}
                  >
                    {ratingWriting ? "Записываем и проверяем..." : "Записать оценку на AnimeGO"}
                  </button>
                  {ratingWriteMessage && <p role="status">{ratingWriteMessage}</p>}
                </>
              )}
              {(runtime.accounts.fetchProgress || runtime.accounts.setProgress) && (
                <>
                  <div className="native-account-progress-readout">
                    {progressSnapshot
                      ? "Текущий прогресс: " + progressSnapshot.watchedEpisodeNumber + " / " + progressSnapshot.episodes.length
                      : "Текущий прогресс ещё не прочитан."}
                  </div>
                  {runtime.accounts.fetchProgress && (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void readAnimeGoProgress()}
                      disabled={progressLoading || progressWriting || ratingWriting || statusWriting || !selectedAnimeGoItemId}
                    >
                      {progressLoading ? "Читаем AnimeGO..." : "Прочитать прогресс эпизодов"}
                    </button>
                  )}
                  {runtime.accounts.setProgress && (
                    <>
                      <label>
                        Просмотрено эпизодов
                        <input
                          type="number"
                          min="0"
                          max={listPreview.items.find((item) => item.listEntryId === selectedAnimeGoItemId)?.episodesTotal ?? undefined}
                          step="1"
                          value={targetAnimeGoProgress}
                          onChange={(event) => setTargetAnimeGoProgress(event.target.value)}
                          disabled={progressLoading || progressWriting || ratingWriting || statusWriting}
                        />
                      </label>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void writeAnimeGoProgress()}
                        disabled={progressLoading || progressWriting || ratingWriting || statusWriting || !selectedAnimeGoItemId}
                      >
                        {progressWriting ? "Записываем и проверяем..." : "Записать прогресс на AnimeGO"}
                      </button>
                    </>
                  )}
                  {progressWriteMessage && <p role="status">{progressWriteMessage}</p>}
                </>
              )}
              <small>Оценка и прогресс изменяют данные на сайте AnimeGO. Для первого теста выбери тайтл, на котором не жалко изменить эти значения.</small>
            </div>
          )}

          {runtime?.accounts.inspectWriteCapabilities && listPreview.items.length > 0 && (
            <button className="secondary-button" type="button" onClick={() => void inspectAnimeGoWriteCapabilities()} disabled={inspectionLoading || listLoading || listImporting}>
              {inspectionLoading ? "Изучаем страницу..." : "Исследовать формы и скрипты (без изменений)"}
            </button>
          )}
          {writeInspection && (
            <div className="native-account-write-inspection" role="status">
              <strong>Проверка страницы завершена. Изменения не отправлялись.</strong>
              <p>Найдено форм: {writeInspection.forms.length}. CSRF meta-поля: {writeInspection.csrfMetaNames.join(", ") || "не найдены"}.</p>
              {writeInspection.forms.map((form, index) => (
                <div key={index}>
                  <p>
                    <strong>{form.method} {form.actionPath}</strong>
                    <small>Назначение: {form.purpose} · Кодировка: {form.enctype}</small>
                    <small>Поля: {form.fieldNames.join(", ") || "нет"}{form.hasCsrfField ? " · CSRF-поле обнаружено" : ""}</small>
                    <small>{form.fields.map((field) => `${field.name} (${field.tag}/${field.inputType}${field.required ? ", обязательно" : ""})`).join(" · ")}</small>
                    {(form.hasInlineEventHandler || form.hasDataAction) && (
                      <small>Обработчики: {form.hasInlineEventHandler ? "inline JS" : ""}{form.hasInlineEventHandler && form.hasDataAction ? " · " : ""}{form.hasDataAction ? "data-action" : ""}</small>
                    )}
                  </p>
                </div>
              ))}
              {writeInspection.interactiveControls.length > 0 && (
                <div>
                  <strong>Интерактивные элементы, похожие на управление списком</strong>
                  {writeInspection.interactiveControls.map((control, index) => (
                    <p key={index}>
                      {control.tag}{control.name ? ` name=${control.name}` : ""}{control.id ? ` #${control.id}` : ""}
                      <small>{control.classNames.join(" ")}{control.required ? " · обязательно" : ""}{control.hasInlineEventHandler ? " · inline JS" : ""}{control.hasDataAction ? " · data-action" : ""}</small>
                      {control.hrefPath && <small>Ссылка действия: {control.hrefPath}</small>}
                      {control.ajaxUrlPath && <small>AJAX-путь: {control.ajaxUrlPath}</small>}
                      {control.controllerNames.length > 0 && <small>Контроллеры: {control.controllerNames.join(", ")}</small>}
                      {control.actionHints.length > 0 && <small>Действия: {control.actionHints.join(" · ")}</small>}
                    </p>
                  ))}
                </div>
              )}
              {writeInspection.accountLists.length > 0 && (
                <div>
                  <strong>Элементы личного списка по категориям AnimeGO</strong>
                  {writeInspection.accountLists.map((list) => (
                    <div key={list.listType}>
                      <p><strong>Категория {list.listType} · HTTP {list.httpStatus}</strong></p>
                      {list.forms.map((form, index) => (
                        <p key={index}>
                          <strong>{form.method} {form.actionPath}</strong>
                          <small>Поля: {form.fieldNames.join(", ") || "нет"}</small>
                        </p>
                      ))}
                      {list.interactiveControls.map((control, index) => (
                        <p key={index}>
                          {control.tag}{control.name ? " name=" + control.name : ""}{control.id ? " #" + control.id : ""}
                          <small>{control.hrefPath ? "Путь: " + control.hrefPath : ""}{control.ajaxUrlPath ? " · AJAX: " + control.ajaxUrlPath : ""}</small>
                          {control.controllerNames.length > 0 && <small>Контроллеры: {control.controllerNames.join(", ")}</small>}
                          {control.actionHints.length > 0 && <small>Действия: {control.actionHints.join(" · ")}</small>}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {writeInspection.sameOriginScriptPaths.length > 0 && (
                <p><strong>Скрипты AnimeGO:</strong><small>{writeInspection.sameOriginScriptPaths.join(", ")}</small></p>
              )}
              {writeInspection.inlineScriptHints.length > 0 && (
                <p><strong>Подсказки из inline JS:</strong><small>{writeInspection.inlineScriptHints.join(", ")}</small></p>
              )}
              <p>
                <strong>Анализ JavaScript-бандлов:</strong>
                <small>Изучено: {writeInspection.scriptsInspected} · пропущено: {writeInspection.scriptsSkipped}</small>
              </p>
              {writeInspection.scriptRouteCandidates.length > 0 && (
                <div>
                  <strong>Кандидаты запросов из скриптов (не подтверждённые API)</strong>
                  {writeInspection.scriptRouteCandidates.map((candidate, index) => (
                    <p key={index}>
                      <strong>{candidate.path}</strong>
                      <small>Методы: {candidate.methods.join(", ")} · Возможности: {candidate.capabilities.join(", ") || "не определены"}</small>
                      <small>Поля: {candidate.fieldHints.join(", ") || "не обнаружены"}{candidate.signals.length ? " · Сигналы: " + candidate.signals.join(", ") : ""}</small>
                    </p>
                  ))}
                </div>
              )}
              <small>{writeInspection.note}</small>
            </div>
          )}
          {listImportMessage && <p role="status">{listImportMessage}</p>}
        </div>
      )}
      {networkInspection && (
        <div className="native-account-write-inspection" role="status">
          <strong>Пассивное наблюдение завершено. Запросы не отправлялись инспектором.</strong>
          <p>Страница: {networkInspection.pagePath} · Окно наблюдения: {networkInspection.durationSeconds} сек. · Событий: {networkInspection.events.length}</p>
          {networkInspection.events.length === 0 ? (
            <p>Подходящих запросов не поймано. Убедись, что окно AnimeGO открыто на странице тайтла, затем повтори наблюдение и выполни обычное действие на сайте.</p>
          ) : (
            networkInspection.events.map((event, index) => (
              <p key={index}>
                <strong>{event.method} {event.path}</strong>
                <small>Транспорт: {event.transport} · HTTP: {event.status ?? "не получен"} · Поля: {event.fieldNames.join(", ") || "не определены"}</small>
              </p>
            ))
          )}
          <small>{networkInspection.note}</small>
        </div>
      )}
    </section>
  );
}
