import { useCallback, useEffect, useState } from "react";
import type { StreamingProviderId } from "../services/streaming-provider.js";
import type { StreamingAccountStatus } from "../services/streaming-account-manager.js";
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
    limitation: "Вход через встроенное окно сайта Windows. Чтение списка подключим через защищённую нативную сессию следующим этапом.",
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
      setListImportMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить личный список AnimeGO.");
    } finally {
      setListLoading(false);
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
                <div className="native-account-actions">
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
          {listImportMessage && <p role="status">{listImportMessage}</p>}
        </div>
      )}
    </section>
  );
}
