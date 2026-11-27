import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamingProviderId } from "../services/streaming-provider.js";
import type { AnimeGoNetworkInspection, AnimeGoWriteInspection, StreamingAccountStatus } from "../services/streaming-account-manager.js";
import type { StreamingRuntime } from "../services/platform/streaming-runtime.js";
import type { AnimeGoAccountListResponse } from "../services/platform/web-streaming-account-manager.js";
import type { AnimeGoConflictChoice, AnimeGoSyncConflict } from "../services/animego-sync-state.js";

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
    limitation: "Вход через встроенное окно Windows. Список читается через защищённую нативную сессию. Работают двусторонняя сверка статуса, прогресса и оценки, очередь подтверждаемых записей и выбор версии при конфликте. Сброс оценки и конфликты удаления пока не поддерживаются.",
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
  onSyncAnimeGo?: () => Promise<{ imported: number; queued: number; deleted?: number; conflicts?: number }>;
  onGetAnimeGoConflicts?: () => Promise<AnimeGoSyncConflict[]>;
  onResolveAnimeGoConflict?: (conflictId: string, choice: AnimeGoConflictChoice) => Promise<AnimeGoSyncConflict[]>;
}

export function StreamingAccountManagerPanel({
  runtime,
  onRetryRuntime,
  runtimeRefreshing = false,
  runtimeRefreshError = "",
  onImportAnimeGoList,
  onSyncAnimeGo,
  onGetAnimeGoConflicts,
  onResolveAnimeGoConflict,
}: Props) {
  const [statuses, setStatuses] = useState<Partial<Record<StreamingProviderId, StreamingAccountStatus>>>({});
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<StreamingProviderId | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncConflicts, setSyncConflicts] = useState<AnimeGoSyncConflict[]>([]);
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const syncCallbackRef = useRef(onSyncAnimeGo);
  const syncInFlightRef = useRef(false);
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
    if (!onSyncAnimeGo || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncLoading(true);
    setError("");
    setSyncMessage("");
    try {
      const result = await onSyncAnimeGo();
      if (onGetAnimeGoConflicts) setSyncConflicts(await onGetAnimeGoConflicts());
      setSyncMessage(
        `Синхронизация завершена. Получено/обновлено: ${result.imported}. Удалено из библиотеки: ${result.deleted ?? 0}. В очереди отправки: ${result.queued}. Конфликты: ${result.conflicts === undefined ? "пока не проверяются" : result.conflicts}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось синхронизировать AnimeGO.");
    } finally {
      syncInFlightRef.current = false;
      setSyncLoading(false);
    }
  }

  useEffect(() => { syncCallbackRef.current = onSyncAnimeGo; }, [onSyncAnimeGo]);

  useEffect(() => {
    if (!onGetAnimeGoConflicts) return;
    void onGetAnimeGoConflicts().then(setSyncConflicts).catch(() => undefined);
  }, [onGetAnimeGoConflicts]);

  async function resolveConflict(conflictId: string, choice: AnimeGoConflictChoice) {
    if (!onResolveAnimeGoConflict || resolvingConflict) return;
    setResolvingConflict(conflictId);
    setError("");
    try {
      setSyncConflicts(await onResolveAnimeGoConflict(conflictId, choice));
      setSyncMessage(choice === "local"
        ? "Выбрана локальная версия. Изменение отправлено в очередь AnimeGO."
        : "Применена версия AnimeGO к локальной библиотеке.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось разрешить конфликт.");
    } finally {
      setResolvingConflict(null);
    }
  }

  useEffect(() => {
    if (!onSyncAnimeGo || !statuses.animego?.connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (disposed || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      void syncCallbackRef.current?.()
        .then(async () => {
          if (onGetAnimeGoConflicts) setSyncConflicts(await onGetAnimeGoConflicts());
        })
        .catch(() => undefined)
        .finally(() => { syncInFlightRef.current = false; });
    };
    timer = setInterval(run, 5 * 60 * 1000);
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", run);
    run();
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [Boolean(onSyncAnimeGo), statuses.animego?.connected, onGetAnimeGoConflicts]);

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
                  {provider.id === "animego" && onSyncAnimeGo && (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => void syncAnimeGo()}
                      disabled={syncLoading || listLoading || disconnecting !== null}
                    >
                      {syncLoading ? "Синхронизируем..." : "Синхронизировать сейчас"}
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
                {provider.id === "animego" && syncConflicts.length > 0 && (
                  <div className="animego-sync-conflicts" aria-live="polite">
                    <h4>Конфликты синхронизации ({syncConflicts.length})</h4>
                    {syncConflicts.map((conflict) => (
                      <div className="animego-sync-conflict" key={conflict.id}>
                        <strong>{conflict.title}</strong>
                        <small>
                          {conflict.field === "status" ? "Статус" : conflict.field === "progress" ? "Прогресс" : "Оценка"}:
                          {" "}локально: {String(conflict.localValue ?? "нет")}; AnimeGO: {String(conflict.remoteValue ?? "нет")}
                        </small>
                        <div className="native-account-actions">
                          <button className="secondary-button" type="button" onClick={() => void resolveConflict(conflict.id, "local")} disabled={resolvingConflict !== null}>
                            {resolvingConflict === conflict.id ? "Сохраняем..." : "Оставить локальную"}
                          </button>
                          <button className="secondary-button" type="button" onClick={() => void resolveConflict(conflict.id, "remote")} disabled={resolvingConflict !== null}>
                            {resolvingConflict === conflict.id ? "Сохраняем..." : "Принять AnimeGO"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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

    </section>
  );
}
