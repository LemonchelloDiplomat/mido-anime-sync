import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { StreamingProviderId } from "../services/streaming-provider.js";
import type { StreamingAccountStatus } from "../services/streaming-account-manager.js";
import type { StreamingRuntime } from "../services/platform/streaming-runtime.js";

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
    limitation: "Подключение через форму сайта. Чтение списка доступно; запись статусов на сайт пока отключена.",
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
}

interface AnimeGoListPreview {
  total: number;
  lists: Array<{ listType: number; itemCount: number; pageCount: number }>;
  items: Array<{ listEntryId: string; title: string; listType: number; episodesWatched: number | null }>;
}

export function StreamingAccountManagerPanel({
  runtime,
  onRetryRuntime,
  runtimeRefreshing = false,
  runtimeRefreshError = "",
}: Props) {
  const [statuses, setStatuses] = useState<Partial<Record<StreamingProviderId, StreamingAccountStatus>>>({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<StreamingProviderId | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [listPreview, setListPreview] = useState<AnimeGoListPreview | null>(null);
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

  async function connectAnimeGo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime || !username.trim() || !password) return;
    setConnecting(true);
    setError("");
    try {
      await runtime.accounts.connect("animego", {
        username: username.trim(),
        password,
        rememberMe,
      });
      setPassword("");
      setListPreview(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подключить AnimeGO.");
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
      if (provider === "animego") setListPreview(null);
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
      const result = await runtime.accounts.fetchList("animego") as AnimeGoListPreview;
      setListPreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить личный список AnimeGO.");
    } finally {
      setListLoading(false);
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
              : "Веб-режим: локальный API доступен. Сессия AnimeGO хранится в зашифрованном локальном хранилище."
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

                {provider.id === "animego" && runtime?.platform === "web-local" && supported && !connected && (
                  <form className="native-account-connect-form" onSubmit={(event) => void connectAnimeGo(event)}>
                    <label>
                      Логин или email AnimeGO
                      <input
                        type="text"
                        autoComplete="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        maxLength={256}
                        required
                      />
                    </label>
                    <label>
                      Пароль
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        maxLength={1024}
                        required
                      />
                    </label>
                    <label className="native-account-remember">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(event) => setRememberMe(event.target.checked)}
                      />
                      Запомнить сессию
                    </label>
                    <button className="secondary-button" type="submit" disabled={connecting || !username.trim() || !password}>
                      {connecting ? "Подключаем..." : "Подключить AnimeGO"}
                    </button>
                    <small>Пароль передаётся только локальному API и не сохраняется. Сохраняется только сессия сайта.</small>
                  </form>
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
          <p>Найдено записей: <strong>{listPreview.total}</strong>. Это предварительное чтение, локальная библиотека пока не изменялась.</p>
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
        </div>
      )}
    </section>
  );
}
