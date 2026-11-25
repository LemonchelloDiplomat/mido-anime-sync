import { useCallback, useEffect, useState } from "react";
import type { StreamingProviderId } from "../services/streaming-provider.js";
import type { AnimeGoNetworkInspection, AnimeGoWriteInspection, StreamingAccountStatus } from "../services/streaming-account-manager.js";
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
    limitation: "Вход через встроенное окно Windows. Личный список читается через защищённую нативную сессию. Запись оценки поддерживается с проверкой результата и офлайн-очередью; статус, прогресс и удаление пока не записываются.",
  },
  {
    id: "anixart",
    name: "Anixart",
    description: "Аккаунт и закладки",
    limitation: "Официальный разрешённый API для сторонней авторизации не подтверждён. Приватные API-вызовы не используются.",
  },
];

interface Props {
  runtime: StreamingRuntime | null;
  onRetryRuntime?: () => void | Promise<void>;
  runtimeRefreshing?: boolean;
  runtimeRefreshError?: string;
  onImportAnimeGoList?: (result: AnimeGoAccountListResponse) => Promise<void>;
  onSyncAnimeGo?: () => Promise<{ imported: number; queued: number; conflicts: number }>;
}

export function StreamingAccountManagerPanel({
  runtime,
  onRetryRuntime,
  runtimeRefreshing = false,
  runtimeRefreshError = "",
  onImportAnimeGoList,
  onSyncAnimeGo,
}: Props) {
  const [statuses, setStatuses] = useState<Partial<Record<StreamingProviderId, StreamingAccountStatus>>>({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<StreamingProviderId | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [listImporting, setListImporting] = useState(false);
  const [listImportMessage, setListImportMessage] = useState("");
  const [authWindowOpened, setAuthWindowOpened] = useState(false);
  const [listPreview, setListPreview] = useState<AnimeGoAccountListResponse | null>(null);
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

  async function syncAnimeGo() {
    if (!onSyncAnimeGo || syncLoading) return;
    setSyncLoading(true);
    setError("");
    setSyncMessage("");
    try {
      const result = await onSyncAnimeGo();
      setSyncMessage(
        `Синхронизация завершена. Получено/обновлено: ${result.imported}. В очереди отправки: ${result.queued}. Конфликтов: ${result.conflicts}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось синхронизировать AnimeGO.");
    } finally {
      setSyncLoading(false);
    }
  }

  useEffect(() => {
    if (!onSyncAnimeGo || !statuses.animego?.connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (disposed || document.visibilityState !== "visible" || !navigator.onLine) return;
      void onSyncAnimeGo().catch(() => undefined);
    };
    timer = setInterval(run, 5 * 60 * 1000);
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [onSyncAnimeGo, statuses.animego?.connected]);

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
                  {provider.id === "animego" && onSyncAnimeGo && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => void syncAnimeGo()}
                      disabled={syncLoading || listLoading || disconnecting !== null}
                    >
                      {syncLoading ? "Синхронизируем..." : "Синхронизировать"}
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
                {provider.id === "animego" && syncMessage && <small role="status">{syncMessage}</small>}
                {provider.id === "animego" && runtime.platform === "windows-native" && (
                  <small>Автосинхронизация выполняется при открытом приложении: каждые 5 минут, при возвращении в окно и после восстановления сети. Очередь локальных изменений сохраняется офлайн.</small>
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
